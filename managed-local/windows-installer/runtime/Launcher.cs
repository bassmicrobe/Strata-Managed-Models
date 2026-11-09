using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Web.Script.Serialization;

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
    private static bool Has(string[] args, string value) { return Array.IndexOf(args, value) >= 0; }
    private static Dictionary<string, object> Json(string value) {
        return new JavaScriptSerializer { MaxJsonLength = 65536 }.Deserialize<Dictionary<string, object>>(value);
    }
    private static string Field(Dictionary<string, object> data, string key) {
        object value; return data != null && data.TryGetValue(key, out value) ? value as string : null;
    }
    private static bool CodingAccepted(string data) {
        string path = Path.Combine(data, "coding.json");
        if (!File.Exists(path)) return false;
        var state = Json(File.ReadAllText(path));
        object version;
        if (state == null || !state.TryGetValue("consentVersion", out version) || Convert.ToInt32(version) != 1 || !Regex.IsMatch(Field(state, "chatId") ?? "", "^managed-coding-[a-f0-9-]{36}$"))
            throw new IOException("自動テストの保存済み設定を確認できません。coding.json をバックアップから復元してください。");
        return true;
    }
    private static void WriteStream(string value, bool error) {
        using (Stream stream = error ? Console.OpenStandardError() : Console.OpenStandardOutput()) {
            byte[] bytes = Encoding.UTF8.GetBytes(value); stream.Write(bytes, 0, bytes.Length); stream.Flush();
        }
    }
    private static Process StartWindow(string root, string data, string flag, string url, string share, string installed, string available) {
        string window = Path.Combine(root, "resources", "desktop", "StrataWindow.exe");
        if (!File.Exists(window)) throw new IOException("専用ウィンドウが見つかりません。最新版のインストーラーで上書きしてください。");
        string arguments = "--managed --data-dir " + Quote(data);
        if (flag != null) arguments += " " + flag;
        if (!String.IsNullOrEmpty(url)) arguments += " --url " + Quote(url);
        if (!String.IsNullOrEmpty(share)) arguments += " --share-url " + Quote(share);
        if (!String.IsNullOrEmpty(installed) && !String.IsNullOrEmpty(available)) arguments += " --installed-release " + Quote(installed) + " --available-release " + Quote(available);
        return Process.Start(new ProcessStartInfo(window, arguments) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true });
    }
    private static void CloseWindow(string root, string data) {
        string record = Path.Combine(data, "desktop-process.json");
        string exe = Path.Combine(root, "resources", "desktop", "StrataWindow.exe");
        if (!File.Exists(record) || !File.Exists(exe)) return;
        try {
            int pid = Convert.ToInt32(Json(File.ReadAllText(record))["pid"]);
            using (Process window = Process.GetProcessById(pid)) {
                if (window.HasExited || !String.Equals(Path.GetFullPath(window.MainModule.FileName), Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase)) return;
                using (Process close = StartWindow(root, data, "--exit-window", null, null, null, null)) {
                    if (close == null || !close.WaitForExit(12000) || close.ExitCode != 0) throw new IOException("Strata のウィンドウを閉じられませんでした。");
                }
                if (!window.WaitForExit(20000)) throw new IOException("Strata のウィンドウが閉じるまでお待ちください。");
            }
        } catch (ArgumentException) { /* The recorded process already exited. */ }
    }
    [STAThread]
    private static int Main(string[] args) {
        bool bridge = Has(args, "--desktop-bridge"), desktopSmoke = Has(args, "--desktop-smoke"), quit = Has(args, "--quit");
        bool modelsOnly = Has(args, "--stop-models");
        bool quiet = bridge || desktopSmoke || modelsOnly;
        foreach (string arg in args) {
            if (modelsOnly && arg != "--stop-models" && arg != "--desktop-bridge" && arg != "--no-browser") return 2;
            if (arg == "--stop-models") continue;
            if (arg == "--stop" || arg == "--smoke" || arg == "--no-browser") quiet = true;
            if (arg != "--stop" && arg != "--wait" && arg != "--smoke" && arg != "--no-browser" && arg != "--models" && arg != "--api" && arg != "--tailscale" && arg != "--tailscale-off" && arg != "--desktop-bridge" && arg != "--desktop-smoke" && arg != "--quit" && arg != "--coding" && !(bridge && arg == "--download-update")) return 2;
        }
        if (Has(args, "--coding") && (Has(args, "--stop") || Has(args, "--quit") || Has(args, "--smoke") || Has(args, "--desktop-smoke") || Has(args, "--models") || Has(args, "--api") || Has(args, "--tailscale") || Has(args, "--tailscale-off") || Has(args, "--download-update"))) return 2;
        bool stopping = quit || Has(args, "--stop"), sharingOff = Has(args, "--tailscale-off");
        bool openWindow = desktopSmoke || !quiet && !stopping && !sharingOff;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string data = Environment.GetEnvironmentVariable("STRATA_MANAGED_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StrataManaged");
        string mutexName;
        using (SHA256 hash = SHA256.Create()) mutexName = "Local\\StrataManaged-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes((Path.GetFullPath(root) + "|" + Path.GetFullPath(data)).ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
        bool acquired = false;
        using (Mutex mutex = new Mutex(false, mutexName)) {
            try {
                try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) { if (bridge) WriteStream("Strata の起動または更新を処理しています。完了までお待ちください。", true); else if (!quiet) MessageBox.Show("Strata の起動または更新を処理しています。完了までお待ちください。", "Strata Managed Models", MessageBoxButtons.OK, MessageBoxIcon.Information); return 3; }
                string node = Path.Combine(root, "resources", "node", "node.exe");
                string script = Path.Combine(root, "runtime", "runtime.mjs");
                if (!File.Exists(node) || !File.Exists(script)) throw new IOException("The application files are incomplete. Run the installer again.");
                bool acceptCoding = false;
                if (Has(args, "--coding") && !CodingAccepted(data)) {
                    if (quiet && !bridge) throw new IOException("最初に Strata メニューの「自動テストでコーディング」から、実行権限を確認してください。");
                    string consent = "専用チャットを作り、モデルによるプロジェクトの編集・テスト実行・失敗ログを使った修正と再実行を有効にします。\n\n" +
                        "このチャットは ByPass モードです。操作ごとの承認を省略し、PC上でコマンドを実行できます。フォルダーの選択はOSのアクセス制限ではありません。\n\n" +
                        "作業前に対象プロジェクトのフォルダーとモデルを選んでください。既存のチャットの権限やモデル設定は変えません。\n\nこの権限で専用チャットを作成しますか？";
                    if (MessageBox.Show(consent, "自動テストでコーディング", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) {
                        if (bridge) WriteStream("{\"cancelled\":true}\n", false);
                        return 0;
                    }
                    acceptCoding = true;
                }
                StringBuilder arguments = new StringBuilder(Quote(script));
                foreach (string arg in args) if (arg != "--desktop-bridge" && arg != "--desktop-smoke" && arg != "--quit") arguments.Append(" ").Append(Quote(arg));
                if (acceptCoding) arguments.Append(" --coding-accept");
                if (quit) arguments.Append(" --stop --wait");
                if (openWindow || bridge) arguments.Append(" --desktop");
                if (desktopSmoke) arguments.Append(" --no-browser --no-update");
                ProcessStartInfo start = new ProcessStartInfo(node, arguments.ToString());
                start.WorkingDirectory = root; start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
                start.RedirectStandardOutput = true; start.RedirectStandardError = true;
                start.StandardOutputEncoding = new UTF8Encoding(false); start.StandardErrorEncoding = new UTF8Encoding(false);
                using (Process process = new Process()) {
                    StringBuilder errors = new StringBuilder(); string result = null;
                    process.StartInfo = start;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null && e.Data.StartsWith("{") && e.Data.Length <= 65536) result = e.Data; };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null && errors.Length < 4096) errors.AppendLine(e.Data); };
                    process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
                    if (process.ExitCode != 0) {
                        if (bridge) WriteStream(errors.ToString(), true);
                        else if (!quiet) MessageBox.Show("Strata の操作を完了できませんでした。\n\n" + errors.ToString() + "\nログ: " + Path.Combine(data, "logs", "launcher.log"), "Strata Managed Models", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return process.ExitCode;
                    }
                    if (bridge) { WriteStream((result ?? "{}") + "\n", false); return 0; }
                    if (stopping) { CloseWindow(root, data); return 0; }
                    if (openWindow || sharingOff && !quiet) {
                        var response = Json(result ?? "{}"); string url = Field(response, "localUrl"), share = Field(response, "tailscaleUrl");
                        if (openWindow && String.IsNullOrEmpty(url)) throw new IOException("Strata のローカル接続先を確認できませんでした。");
                        using (Process window = StartWindow(root, data, desktopSmoke ? "--smoke" : sharingOff ? "--refresh-window" : null, url, share, Field(response,"installedReleaseTag"), Field(response,"latestInstallerTag"))) {
                            if (window == null) throw new IOException("専用ウィンドウを起動できませんでした。");
                            if (desktopSmoke) {
                                if (!window.WaitForExit(60000)) { window.Kill(); throw new IOException("専用ウィンドウの検証が時間内に完了しませんでした。"); }
                                return window.ExitCode;
                            }
                        }
                        if (sharingOff) MessageBox.Show("Tailscale共有を停止しました。", "Strata Managed Models", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    return 0;
                }
            } catch (Exception error) {
                try { string logs = Path.Combine(data, "logs"); Directory.CreateDirectory(logs); File.AppendAllText(Path.Combine(logs, "desktop-launcher.log"), error.Message + "\n", Encoding.UTF8); } catch { }
                if (bridge) WriteStream(error.Message, true); else if (!quiet) MessageBox.Show(error.Message, "Strata Managed Models", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
            }
            finally { if (acquired) mutex.ReleaseMutex(); }
        }
    }
}
