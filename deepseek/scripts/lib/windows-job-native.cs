using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class DeepseekJobGuard : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool belongs);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr job;
    readonly int hostPid;
    static void Require(bool ok, string step = "unknown") { if (!ok) throw new InvalidOperationException("Job Object operation failed: " + step); }
    static string Name(string token) { return "Local\\deepseek-" + token; }
    public DeepseekJobGuard(int pid, IntPtr process, string token) {
        hostPid = pid;
        job = CreateJobObject(IntPtr.Zero, Name(token)); // 不可继承；唯一作业编号隔离命名对象。
        int error = Marshal.GetLastWin32Error();
        Require(job != IntPtr.Zero);
        try {
            Require(error != 183); // ERROR_ALREADY_EXISTS：不能重新占用别的作业对象。
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE；不允许 breakaway。
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            Require(AssignProcessToJobObject(job, process));
        } catch { Dispose(); throw; }
    }
    // 调用者已持有并核对宿主实例；仍需确认该实例属于命名 Job，名称本身不是权限凭证。
    public static IntPtr OpenForProcess(string token, IntPtr process) {
        IntPtr handle = OpenJobObject(4 | 8, false, Name(token)); // QUERY | TERMINATE
        if (handle == IntPtr.Zero) { Require(Marshal.GetLastWin32Error() == 2); return IntPtr.Zero; }
        try {
            bool belongs;
            Require(IsProcessInJob(process, handle, out belongs) && belongs);
            return handle;
        } catch { CloseHandle(handle); throw; }
    }
    public static void Terminate(IntPtr handle) { Require(TerminateJobObject(handle, 1)); }
    public static void Close(IntPtr handle) { CloseHandle(handle); }
    int[] Members() {
        int capacity = 16;
        for (;;) {
            int size = checked(8 + capacity * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                bool ok = QueryInformationJobObject(job, 3, buffer, (uint)size, IntPtr.Zero);
                int error = Marshal.GetLastWin32Error();
                if (!ok) {
                    Require(error == 234, "members:" + error); // ERROR_MORE_DATA：进程列表增长，重新分配。
                    capacity = checked(Math.Max(capacity * 2, Marshal.ReadInt32(buffer)));
                    continue;
                }
                int count = Marshal.ReadInt32(buffer, 4);
                var ids = new int[count];
                for (int i = 0; i < count; i++) ids[i] = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                return ids;
            } finally { Marshal.FreeHGlobal(buffer); }
        }
    }
    public void CleanDescendants() {
        var elapsed = Stopwatch.StartNew();
        for (;;) {
            bool remaining = false;
            foreach (int pid in Members()) {
                if (pid == hostPid) continue;
                IntPtr process = OpenProcess(0x1000 | 0x100000 | 1, false, pid); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE | TERMINATE
                if (process == IntPtr.Zero) {
                    if (Marshal.GetLastWin32Error() != 87) remaining = true;
                    continue;
                }
                try {
                    if (WaitForSingleObject(process, 0) == 0) continue;
                    bool belongs;
                    Require(IsProcessInJob(process, job, out belongs), "membership");
                    if (!belongs) continue; // PID 已复用：持句柄核实，绝不终止新实例。
                    var image = new StringBuilder(32768);
                    int size = image.Capacity;
                    if (!QueryFullProcessImageName(process, 0, image, ref size)) {
                        // 正在启动/退出的实例可能暂时无法查询映像。未核实之前不
                        // 结束它；下一轮重新从 Job 查询并核对，不用历史 PID 猜测。
                        if (WaitForSingleObject(process, 0) != 0) remaining = true;
                        continue;
                    }
                    // conhost 可能承载宿主共享的控制台。留到最终 taskkill/Job 关闭时
                    // 一起清理，不能先关闭控制台导致宿主在排空输出、发 IPC 前退出。
                    if (String.Equals(image.ToString(), System.IO.Path.Combine(Environment.SystemDirectory, "conhost.exe"), StringComparison.OrdinalIgnoreCase)) continue;
                    remaining = true;
                    Require(TerminateProcess(process, 1) || WaitForSingleObject(process, 0) == 0, "terminate");
                    Require(WaitForSingleObject(process, 5000) == 0, "wait");
                } finally { CloseHandle(process); }
            }
            if (!remaining) return;
            Require(elapsed.ElapsedMilliseconds < 5000, "deadline");
            Thread.Sleep(10); // 再查询一次，覆盖清理期间新生的后代。
        }
    }
    public void Dispose() { if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } }
}
