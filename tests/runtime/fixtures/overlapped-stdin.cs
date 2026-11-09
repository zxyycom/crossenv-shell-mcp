using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class OverlappedInputFixture
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetStdHandle(int kind, IntPtr handle);
    private static NamedPipeClientStream input;

    public static void Install()
    {
        var original = new FileStream(new SafeFileHandle(GetStdHandle(-10), false), FileAccess.Read);
        var name = "project-file-overlapped-" + Guid.NewGuid().ToString("N");
        var writer = new NamedPipeServerStream(name, PipeDirection.Out, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        input = new NamedPipeClientStream(".", name, PipeDirection.In, PipeOptions.Asynchronous);
        var connected = writer.WaitForConnectionAsync();
        input.Connect(5000);
        connected.GetAwaiter().GetResult();
        Task.Run(async delegate {
            try { await original.CopyToAsync(writer); }
            finally { writer.Dispose(); original.Dispose(); }
        });
        if (!SetStdHandle(-10, input.SafePipeHandle.DangerousGetHandle()))
            throw new System.ComponentModel.Win32Exception();
    }
}
