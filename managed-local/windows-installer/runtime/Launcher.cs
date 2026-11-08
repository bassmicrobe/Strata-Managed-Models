using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher {
    private static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); }
            else { result.Append('\\', slashes); result.Append(ch); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    [STAThread]
    private static int Main(string[] args) {
        bool quiet = false;
        foreach (string arg in args) {
            if (arg == "--stop" || arg == "--smoke" || arg == "--no-browser") quiet = true;
            if (arg != "--stop" && arg != "--wait" && arg != "--smoke" && arg != "--no-browser" && arg != "--models" && arg != "--api") return 2;
        }
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string data = Environment.GetEnvironmentVariable("STRATA_MANAGED_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StrataManaged");
        string mutexName;
        using (SHA256 hash = SHA256.Create()) mutexName = "Local\\StrataManaged-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes((Path.GetFullPath(root) + "|" + Path.GetFullPath(data)).ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
        bool acquired = false;
        using (Mutex mutex = new Mutex(false, mutexName)) {
            try {
                try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) { if (!quiet) MessageBox.Show("Strata の起動または更新を処理しています。完了までお待ちください。", "Strata Managed Models", MessageBoxButtons.OK, MessageBoxIcon.Information); return 3; }
                string node = Path.Combine(root, "resources", "node", "node.exe");
                string script = Path.Combine(root, "runtime", "runtime.mjs");
                if (!File.Exists(node) || !File.Exists(script)) throw new IOException("The application files are incomplete. Run the installer again.");
                StringBuilder arguments = new StringBuilder(Quote(script));
                foreach (string arg in args) arguments.Append(" ").Append(Quote(arg));
                ProcessStartInfo start = new ProcessStartInfo(node, arguments.ToString());
                start.WorkingDirectory = root; start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
                start.RedirectStandardOutput = true; start.RedirectStandardError = true;
                start.StandardOutputEncoding = new UTF8Encoding(false); start.StandardErrorEncoding = new UTF8Encoding(false);
                using (Process process = new Process()) {
                    StringBuilder errors = new StringBuilder();
                    process.StartInfo = start;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null && errors.Length < 4096) errors.AppendLine(e.Data); };
                    process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
                    if (process.ExitCode != 0 && !quiet) MessageBox.Show("Strata を起動できませんでした。\n\n" + errors.ToString() + "\nログ: " + Path.Combine(data, "logs", "launcher.log"), "Strata Managed Models", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return process.ExitCode;
                }
            } catch (Exception error) { if (!quiet) MessageBox.Show(error.Message, "Strata Managed Models", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
            finally { if (acquired) mutex.ReleaseMutex(); }
        }
    }
}
