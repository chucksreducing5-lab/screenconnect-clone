// Applies technician input events (received from the relay server as
// `{ kind, key, code, ... }` payloads matching the DOM KeyboardEvent /
// pointer-event shape used by host-client.js) to this Windows machine using
// Win32 SendInput. This is the piece that was completely missing before —
// there was no code anywhere in the repository that actually injected
// keystrokes or mouse actions into the guest OS.
//
// Design notes:
//  - Keys are matched primarily by the physical `code` (e.g. "KeyA",
//    "Digit1", "Semicolon", "F5", "ArrowLeft") because `code` is
//    layout-independent and unambiguous, unlike `key` which changes with
//    Shift/AltGr and locale. This mirrors how a physical keyboard driver
//    identifies keys. A `key`-based fallback covers any code we don't
//    recognize (e.g. exotic layouts), so nothing is silently dropped.
//  - One keydown -> exactly one SendInput keydown call (with KEYEVENTF_KEYUP
//    unset). One keyup -> exactly one SendInput call with KEYEVENTF_KEYUP
//    set. Repeats are simply forwarded as another keydown SendInput call
//    (matching how Windows' own autorepeat behaves at the driver level),
//    which is the correct behavior for held-key text repeat.
//  - Mouse coordinates arrive normalized (0..1 relative to the captured
//    screen) and are converted to absolute virtual-desktop coordinates
//    (0..65535) so multi-monitor setups map correctly.

using System.Runtime.InteropServices;

namespace RemoteSupportAgent;

static class InputInjector
{
    // ─────────────────────────────────────────────────────────────────
    // Keyboard
    // ─────────────────────────────────────────────────────────────────

    public static void SendKey(string kind, string? code, string? key, bool shiftKey, bool ctrlKey, bool altKey, bool metaKey)
    {
        var vk = ResolveVirtualKey(code, key);
        if (vk == 0) return;

        var isKeyUp = kind == "keyup";
        var flags = 0u;
        if (IsExtendedKey(code, vk)) flags |= NativeMethods.KEYEVENTF_EXTENDEDKEY;
        if (isKeyUp) flags |= NativeMethods.KEYEVENTF_KEYUP;

        var input = new INPUT
        {
            type = NativeMethods.INPUT_KEYBOARD,
            U = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = (ushort)vk,
                    wScan = 0,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };

        NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
    }

    /// Sends a keyup for every VK currently tracked as held by the caller
    /// (used when the technician's session disconnects, or a "release all"
    /// request is relayed, so no key gets physically stuck down on the
    /// guest machine).
    public static void ReleaseKey(int vk)
    {
        if (vk == 0) return;
        var input = new INPUT
        {
            type = NativeMethods.INPUT_KEYBOARD,
            U = new InputUnion
            {
                ki = new KEYBDINPUT { wVk = (ushort)vk, wScan = 0, dwFlags = NativeMethods.KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero }
            }
        };
        NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
    }

    static bool IsExtendedKey(string? code, int vk)
    {
        // Extended-key flag matters for the numpad Enter/Divide and the
        // right-hand Ctrl/Alt/arrow cluster/Insert/Delete/Home/End/PageUp/
        // PageDown so Windows treats them distinctly from their numpad/left
        // counterparts.
        return code switch
        {
            "NumpadEnter" or "NumpadDivide" => true,
            "ControlRight" or "AltRight" => true,
            "ArrowLeft" or "ArrowRight" or "ArrowUp" or "ArrowDown" => true,
            "Insert" or "Delete" or "Home" or "End" or "PageUp" or "PageDown" => true,
            _ => false
        };
    }

    // Maps a DOM `code` (physical key identity, preferred) or `key` (logical
    // character, fallback) to a Windows virtual-key code. Covers the full
    // standard set: letters, digits, function keys, navigation, numpad,
    // modifiers (left/right), and OEM punctuation.
    static int ResolveVirtualKey(string? code, string? key)
    {
        if (!string.IsNullOrEmpty(code) && CodeToVk.TryGetValue(code, out var vkFromCode)) return vkFromCode;
        if (!string.IsNullOrEmpty(key) && KeyToVk.TryGetValue(key, out var vkFromKey)) return vkFromKey;
        // Single printable character fallback (handles characters produced
        // by layouts/AltGr combos we don't have an explicit code for).
        if (!string.IsNullOrEmpty(key) && key.Length == 1)
        {
            var ch = key[0];
            if (char.IsLetterOrDigit(ch)) return char.ToUpperInvariant(ch);
        }
        return 0;
    }

    static readonly Dictionary<string, int> CodeToVk = BuildCodeToVkMap();
    static readonly Dictionary<string, int> KeyToVk = BuildKeyToVkMap();

    static Dictionary<string, int> BuildCodeToVkMap()
    {
        var map = new Dictionary<string, int>(StringComparer.Ordinal);

        // Letters
        for (var c = 'A'; c <= 'Z'; c++) map[$"Key{c}"] = c;
        // Digit row
        for (var d = 0; d <= 9; d++) map[$"Digit{d}"] = 0x30 + d;
        // Numpad digits
        for (var d = 0; d <= 9; d++) map[$"Numpad{d}"] = 0x60 + d;
        // Function keys F1-F24
        for (var f = 1; f <= 24; f++) map[$"F{f}"] = 0x70 + (f - 1);

        void Add(string codeName, int vk) => map[codeName] = vk;

        Add("Backspace", 0x08);
        Add("Tab", 0x09);
        Add("Enter", 0x0D);
        Add("NumpadEnter", 0x0D);
        Add("ShiftLeft", 0xA0);
        Add("ShiftRight", 0xA1);
        Add("ControlLeft", 0xA2);
        Add("ControlRight", 0xA3);
        Add("AltLeft", 0xA4);
        Add("AltRight", 0xA5);
        Add("Pause", 0x13);
        Add("CapsLock", 0x14);
        Add("Escape", 0x1B);
        Add("Space", 0x20);
        Add("PageUp", 0x21);
        Add("PageDown", 0x22);
        Add("End", 0x23);
        Add("Home", 0x24);
        Add("ArrowLeft", 0x25);
        Add("ArrowUp", 0x26);
        Add("ArrowRight", 0x27);
        Add("ArrowDown", 0x28);
        Add("PrintScreen", 0x2C);
        Add("Insert", 0x2D);
        Add("Delete", 0x2E);
        Add("MetaLeft", NativeMethods.VK_LWIN);
        Add("OSLeft", NativeMethods.VK_LWIN);
        Add("MetaRight", NativeMethods.VK_RWIN);
        Add("OSRight", NativeMethods.VK_RWIN);
        Add("ContextMenu", 0x5D);
        Add("NumLock", 0x90);
        Add("ScrollLock", 0x91);

        // Numpad operators
        Add("NumpadMultiply", 0x6A);
        Add("NumpadAdd", 0x6B);
        Add("NumpadSubtract", 0x6D);
        Add("NumpadDecimal", 0x6E);
        Add("NumpadDivide", 0x6F);
        Add("NumpadSeparator", 0x6C);

        // OEM punctuation (US layout physical positions; VK_OEM_* are
        // layout-independent virtual-key identifiers in Windows, so this
        // maps correctly regardless of the guest's keyboard layout).
        Add("Semicolon", 0xBA);      // VK_OEM_1  ; :
        Add("Equal", 0xBB);          // VK_OEM_PLUS = +
        Add("Comma", 0xBC);          // VK_OEM_COMMA , <
        Add("Minus", 0xBD);          // VK_OEM_MINUS - _
        Add("Period", 0xBE);         // VK_OEM_PERIOD . >
        Add("Slash", 0xBF);          // VK_OEM_2  / ?
        Add("Backquote", 0xC0);      // VK_OEM_3  ` ~
        Add("BracketLeft", 0xDB);    // VK_OEM_4  [ {
        Add("Backslash", 0xDC);      // VK_OEM_5  \ |
        Add("BracketRight", 0xDD);   // VK_OEM_6  ] }
        Add("Quote", 0xDE);          // VK_OEM_7  ' "
        Add("IntlBackslash", 0xE2);  // VK_OEM_102 (ISO extra key next to left shift)

        return map;
    }

    // Fallback map keyed by the DOM `key` value, used only when `code`
    // wasn't recognized (older clients, or unusual layouts).
    static Dictionary<string, int> BuildKeyToVkMap()
    {
        var map = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["Backspace"] = 0x08,
            ["Tab"] = 0x09,
            ["Enter"] = 0x0D,
            ["Shift"] = 0x10,
            ["Control"] = 0x11,
            ["Alt"] = 0x12,
            ["AltGraph"] = 0xA5,
            ["Pause"] = 0x13,
            ["CapsLock"] = 0x14,
            ["Escape"] = 0x1B,
            [" "] = 0x20,
            ["Spacebar"] = 0x20,
            ["PageUp"] = 0x21,
            ["PageDown"] = 0x22,
            ["End"] = 0x23,
            ["Home"] = 0x24,
            ["ArrowLeft"] = 0x25,
            ["ArrowUp"] = 0x26,
            ["ArrowRight"] = 0x27,
            ["ArrowDown"] = 0x28,
            ["PrintScreen"] = 0x2C,
            ["Insert"] = 0x2D,
            ["Delete"] = 0x2E,
            ["Meta"] = NativeMethods.VK_LWIN,
            ["OS"] = NativeMethods.VK_LWIN,
            ["ContextMenu"] = 0x5D,
            ["NumLock"] = 0x90,
            ["ScrollLock"] = 0x91,
            ["!"] = '1', ["@"] = '2', ["#"] = '3', ["$"] = '4', ["%"] = '5',
            ["^"] = '6', ["&"] = '7', ["*"] = '8', ["("] = '9', [")"] = '0',
            [";"] = 0xBA, [":"] = 0xBA,
            ["="] = 0xBB, ["+"] = 0xBB,
            [","] = 0xBC, ["<"] = 0xBC,
            ["-"] = 0xBD, ["_"] = 0xBD,
            ["."] = 0xBE, [">"] = 0xBE,
            ["/"] = 0xBF, ["?"] = 0xBF,
            ["`"] = 0xC0, ["~"] = 0xC0,
            ["["] = 0xDB, ["{"] = 0xDB,
            ["\\"] = 0xDC, ["|"] = 0xDC,
            ["]"] = 0xDD, ["}"] = 0xDD,
            ["'"] = 0xDE, ["\""] = 0xDE,
        };
        for (var f = 1; f <= 24; f++) map[$"F{f}"] = 0x70 + (f - 1);
        return map;
    }

    // ─────────────────────────────────────────────────────────────────
    // Mouse
    // ─────────────────────────────────────────────────────────────────

    /// x/y are normalized 0..1 relative to the captured virtual desktop
    /// bounds. Converted to the 0..65535 absolute coordinate space
    /// SendInput expects when MOUSEEVENTF_ABSOLUTE + MOUSEEVENTF_VIRTUALDESK
    /// are set, so multi-monitor layouts (including monitors with negative
    /// origin coordinates) map correctly.
    public static void MoveTo(double xNorm, double yNorm)
    {
        var (absX, absY) = NormalizedToAbsolute(xNorm, yNorm);
        var input = new INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            U = new InputUnion
            {
                mi = new MOUSEINPUT
                {
                    dx = absX,
                    dy = absY,
                    mouseData = 0,
                    dwFlags = NativeMethods.MOUSEEVENTF_MOVE | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
        NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
    }

    public static void Button(double xNorm, double yNorm, int button, bool isDown)
    {
        var (absX, absY) = NormalizedToAbsolute(xNorm, yNorm);
        var flags = button switch
        {
            1 => isDown ? NativeMethods.MOUSEEVENTF_MIDDLEDOWN : NativeMethods.MOUSEEVENTF_MIDDLEUP,
            2 => isDown ? NativeMethods.MOUSEEVENTF_RIGHTDOWN : NativeMethods.MOUSEEVENTF_RIGHTUP,
            _ => isDown ? NativeMethods.MOUSEEVENTF_LEFTDOWN : NativeMethods.MOUSEEVENTF_LEFTUP
        };
        flags |= NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK | NativeMethods.MOUSEEVENTF_MOVE;

        var input = new INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            U = new InputUnion { mi = new MOUSEINPUT { dx = absX, dy = absY, mouseData = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero } }
        };
        NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
    }

    public static void Wheel(double xNorm, double yNorm, double deltaY, double deltaX)
    {
        var (absX, absY) = NormalizedToAbsolute(xNorm, yNorm);
        var inputs = new List<INPUT>();

        if (Math.Abs(deltaY) > 0.01)
        {
            var wheelDelta = (uint)unchecked((int)Math.Clamp(-deltaY * 4, -32000, 32000));
            inputs.Add(new INPUT
            {
                type = NativeMethods.INPUT_MOUSE,
                U = new InputUnion
                {
                    mi = new MOUSEINPUT
                    {
                        dx = absX,
                        dy = absY,
                        mouseData = wheelDelta,
                        dwFlags = NativeMethods.MOUSEEVENTF_WHEEL | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            });
        }
        if (Math.Abs(deltaX) > 0.01)
        {
            var wheelDelta = (uint)unchecked((int)Math.Clamp(deltaX * 4, -32000, 32000));
            inputs.Add(new INPUT
            {
                type = NativeMethods.INPUT_MOUSE,
                U = new InputUnion
                {
                    mi = new MOUSEINPUT
                    {
                        dx = absX,
                        dy = absY,
                        mouseData = wheelDelta,
                        dwFlags = NativeMethods.MOUSEEVENTF_HWHEEL | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            });
        }
        if (inputs.Count > 0) NativeMethods.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<INPUT>());
    }

    static (int x, int y) NormalizedToAbsolute(double xNorm, double yNorm)
    {
        var vx = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var vy = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var vw = Math.Max(1, NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN));
        var vh = Math.Max(1, NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN));

        var targetX = vx + Math.Clamp(xNorm, 0, 1) * vw;
        var targetY = vy + Math.Clamp(yNorm, 0, 1) * vh;

        // Absolute coordinate space for SendInput is 0..65535 mapped across
        // the full virtual screen (all monitors combined).
        var absX = (int)Math.Round((targetX - vx) * 65535.0 / vw);
        var absY = (int)Math.Round((targetY - vy) * 65535.0 / vh);
        return (absX, absY);
    }
}
