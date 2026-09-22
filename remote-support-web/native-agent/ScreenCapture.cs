// Real desktop capture for the guest/customer machine using GDI BitBlt
// against the full virtual screen (all monitors). This did not exist
// anywhere in the previous codebase — the native "Agent" build was just a
// relabeled copy of the technician's Host Viewer with no capture code at
// all.
//
// Quality: captures at full native desktop resolution (no forced
// downscale) and encodes as JPEG with a configurable quality tier, mirroring
// the browser capture engine's tier concept (public/customer.js SCCapture)
// so the same adaptive-quality philosophy applies to the native path:
// prefer high resolution/quality by default, only step down under
// genuinely poor bandwidth.

using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace RemoteSupportAgent;

sealed class ScreenCapture : IDisposable
{
    static readonly ImageCodecInfo JpegEncoder = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);

    Bitmap? reusableBitmap;
    Graphics? reusableGraphics;
    int lastWidth = -1;
    int lastHeight = -1;

    public sealed record Tier(int MaxWidth, long JpegQuality, string Label);

    // Same spirit as the browser's QUALITY_TIERS: default to a high-quality
    // tier and only downgrade under sustained poor conditions.
    public static readonly Tier[] Tiers =
    [
        new Tier(2560, 92, "Retina (1440p)"),
        new Tier(1920, 90, "Ultra (1080p)"),
        new Tier(1920, 82, "High"),
        new Tier(1280, 72, "Medium"),
        new Tier(1024, 58, "Low"),
        new Tier(800, 45, "Minimal"),
    ];

    public int CurrentTierIndex { get; private set; } = 1; // start at Ultra (1080p) like the browser default

    public Tier CurrentTier => Tiers[Math.Clamp(CurrentTierIndex, 0, Tiers.Length - 1)];

    public void UpgradeTier()
    {
        if (CurrentTierIndex > 0) CurrentTierIndex--;
    }

    public void DowngradeTier()
    {
        if (CurrentTierIndex < Tiers.Length - 1) CurrentTierIndex++;
    }

    /// Captures the full virtual desktop (spanning all monitors), scales to
    /// the current tier's max width using high-quality bicubic
    /// interpolation (matching the "high-quality smoothing" requirement
    /// used elsewhere in the app), and returns JPEG bytes plus the
    /// resulting pixel dimensions.
    public (byte[] Jpeg, int Width, int Height)? CaptureFrame()
    {
        var vx = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var vy = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var vw = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN);
        var vh = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN);
        if (vw <= 0 || vh <= 0) return null;

        using var full = new Bitmap(vw, vh, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(full))
        {
            g.CopyFromScreen(vx, vy, 0, 0, new Size(vw, vh), CopyPixelOperation.SourceCopy);
        }

        var tier = CurrentTier;
        var scale = Math.Min(1.0, tier.MaxWidth / (double)vw);
        var outW = Math.Max(1, (int)Math.Round(vw * scale));
        var outH = Math.Max(1, (int)Math.Round(vh * scale));

        Bitmap toEncode;
        bool disposeAfter;
        if (scale >= 0.999)
        {
            toEncode = full;
            disposeAfter = false;
        }
        else
        {
            EnsureReusable(outW, outH);
            reusableGraphics!.Clear(Color.Black);
            reusableGraphics.CompositingQuality = CompositingQuality.HighQuality;
            reusableGraphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            reusableGraphics.SmoothingMode = SmoothingMode.HighQuality;
            reusableGraphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            reusableGraphics.DrawImage(full, 0, 0, outW, outH);
            toEncode = reusableBitmap!;
            disposeAfter = false;
        }

        using var ms = new MemoryStream();
        using (var encoderParams = new EncoderParameters(1))
        {
            encoderParams.Param[0] = new EncoderParameter(Encoder.Quality, tier.JpegQuality);
            toEncode.Save(ms, JpegEncoder, encoderParams);
        }
        if (disposeAfter) toEncode.Dispose();

        return (ms.ToArray(), outW, outH);
    }

    void EnsureReusable(int w, int h)
    {
        if (reusableBitmap is not null && lastWidth == w && lastHeight == h) return;
        reusableGraphics?.Dispose();
        reusableBitmap?.Dispose();
        reusableBitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        reusableGraphics = Graphics.FromImage(reusableBitmap);
        lastWidth = w;
        lastHeight = h;
    }

    public void Dispose()
    {
        reusableGraphics?.Dispose();
        reusableBitmap?.Dispose();
    }
}
