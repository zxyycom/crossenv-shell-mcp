using System;
using System.IO;

public sealed class SmallReadFixture : Stream
{
    private readonly Stream input;
    public SmallReadFixture(Stream input) { this.input = input; }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position {
        get { throw new NotSupportedException(); }
        set { throw new NotSupportedException(); }
    }
    public override int Read(byte[] buffer, int offset, int count) {
        return input.Read(buffer, offset, Math.Min(16, count));
    }
    public override int ReadByte() { return input.ReadByte(); }
    public override void Flush() { throw new NotSupportedException(); }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
