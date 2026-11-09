using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ProjectFileStdio
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int kind);

    public static FileStream OpenInput()
    {
        var handle = GetStdHandle(-10);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
            throw new System.ComponentModel.Win32Exception();
        // ConsoleStream waits incorrectly on Win32-OpenSSH's overlapped stdin handle.
        // The standard handle is process-owned; this stream must not release it.
        return new FileStream(new SafeFileHandle(handle, false), FileAccess.Read, 1, false);
    }
}
