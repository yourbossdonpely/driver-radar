using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DriverRadarSetup
{
    /// <summary>
    /// DriverRadar setup / launcher / uninstaller.
    ///
    /// One binary, three jobs:
    ///   - no arguments, payload not extracted next to it -> setup wizard;
    ///   - no arguments, running from an install folder      -> launch start.cmd;
    ///   - --uninstall                                        -> remove the install.
    ///
    /// The app itself is embedded as a ZIP resource, so setup needs no network,
    /// no administrator rights and no other installer runtime.
    /// </summary>
    internal static class Program
    {
        internal const string PayloadResource = "DriverRadar.payload.zip";
        internal const string LauncherName = "DriverRadar.exe";
        internal const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DriverRadar";
        internal const string ProjectUrl = "https://github.com/yourbossdonpely/driver-radar";

        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = HasFlag(args, "--silent");
            bool uninstall = HasFlag(args, "--uninstall");
            string extractTarget = ValueOf(args, "--extract");
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);

            try
            {
                // Verification / scripting mode: put the payload on disk, nothing else.
                if (!string.IsNullOrEmpty(extractTarget))
                {
                    Installer.ExtractOnly(baseDir, extractTarget);
                    return 0;
                }

                if (uninstall)
                {
                    return Uninstaller.Run(baseDir, silent);
                }

                // Running from an existing install: the shortcut just opens the app.
                if (Installer.IsInstalled(baseDir))
                {
                    return Launcher.Run(baseDir);
                }

                if (silent)
                {
                    Installer.Install(baseDir, Installer.DefaultTarget, true);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new SetupForm(baseDir));
                return 0;
            }
            catch (Exception ex)
            {
                Fail(ex, silent);
                return 1;
            }
        }

        private static bool HasFlag(string[] args, string flag)
        {
            foreach (string arg in args)
            {
                if (string.Equals(arg, flag, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static string ValueOf(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            }
            return null;
        }

        private static void Fail(Exception ex, bool silent)
        {
            string log = Path.Combine(Path.GetTempPath(), "DriverRadar-setup.log");
            try
            {
                File.AppendAllText(
                    log,
                    "[" + DateTime.Now.ToString("s") + "] " + ex + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch
            {
                // A failing logger must never hide the original error.
            }

            if (!silent)
            {
                MessageBox.Show(
                    "DriverRadar setup could not finish.\n\n" + ex.Message + "\n\nDetails: " + log,
                    "DriverRadar setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }
    }

    internal static class Installer
    {
        internal static string DefaultTarget
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DriverRadar");
            }
        }

        internal static bool IsInstalled(string dir)
        {
            return File.Exists(Path.Combine(dir, "server.js"))
                && File.Exists(Path.Combine(dir, "start.cmd"));
        }

        internal static void ExtractOnly(string baseDir, string target)
        {
            target = Path.GetFullPath(target);
            Directory.CreateDirectory(target);
            ExtractPayload(target);

            // The launcher doubles as the uninstaller, so it belongs in the folder.
            string self = Path.Combine(target, Program.LauncherName);
            if (!string.Equals(
                    Path.GetFullPath(baseDir).TrimEnd(Path.DirectorySeparatorChar),
                    Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(Application.ExecutablePath, self, true);
            }
        }

        internal static void Install(string baseDir, string target, bool desktopShortcut)
        {
            ExtractOnly(baseDir, target);

            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            Shortcuts.Create(target, Path.Combine(programs, "DriverRadar.lnk"));

            if (desktopShortcut)
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                Shortcuts.Create(target, Path.Combine(desktop, "DriverRadar.lnk"));
            }

            Register(target);
        }

        private static void ExtractPayload(string target)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream(Program.PayloadResource))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("This installer is missing its payload.");
                }

                using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    string root = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        if (string.IsNullOrEmpty(entry.Name)) continue; // directory entry

                        string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string destination = Path.GetFullPath(Path.Combine(root, relative));

                        // A ZIP entry named ..\..\windows\... must never escape the target.
                        if (!destination.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("Refusing to write outside the install folder: " + entry.FullName);
                        }

                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                        entry.ExtractToFile(destination, true);
                    }
                }
            }
        }

        private static void Register(string target)
        {
            string launcher = Path.Combine(target, Program.LauncherName);

            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Program.UninstallKeyPath))
            {
                key.SetValue("DisplayName", "DriverRadar");
                key.SetValue("DisplayVersion", BuildInfo.Version);
                key.SetValue("Publisher", "DriverRadar contributors");
                key.SetValue("InstallLocation", target);
                key.SetValue("DisplayIcon", launcher + ",0");
                key.SetValue("UninstallString", "\"" + launcher + "\" --uninstall");
                key.SetValue("QuietUninstallString", "\"" + launcher + "\" --uninstall --silent");
                key.SetValue("URLInfoAbout", Program.ProjectUrl);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", EstimateSizeKb(target), RegistryValueKind.DWord);
            }
        }

        private static int EstimateSizeKb(string target)
        {
            long bytes = 0;
            try
            {
                foreach (string file in Directory.GetFiles(target, "*", SearchOption.AllDirectories))
                {
                    try { bytes += new FileInfo(file).Length; }
                    catch { /* locked or vanished: not worth failing the install */ }
                }
            }
            catch
            {
                // Size is cosmetic in Add/Remove Programs.
            }
            return (int)Math.Max(1, bytes / 1024);
        }
    }

    internal static class Shortcuts
    {
        internal static void Create(string target, string shortcutPath)
        {
            string launcher = Path.Combine(target, Program.LauncherName);

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                throw new InvalidOperationException("Windows Script Host is unavailable, so shortcuts cannot be created.");
            }

            dynamic shell = Activator.CreateInstance(shellType);
            dynamic link = shell.CreateShortcut(shortcutPath);
            link.TargetPath = launcher;
            link.Arguments = string.Empty;
            link.WorkingDirectory = target;
            link.IconLocation = launcher + ",0";
            link.Description = "DriverRadar - Windows driver scanner and updater";
            link.Save();
        }

        internal static void Delete(string shortcutPath)
        {
            try
            {
                if (File.Exists(shortcutPath)) File.Delete(shortcutPath);
            }
            catch
            {
                // A shortcut the user moved or locked is not worth failing over.
            }
        }
    }

    internal static class Launcher
    {
        internal static int Run(string dir)
        {
            string startCmd = Path.Combine(dir, "start.cmd");
            if (!File.Exists(startCmd))
            {
                MessageBox.Show(
                    "DriverRadar is incomplete: start.cmd is missing from\n" + dir + "\n\nReinstall the app.",
                    "DriverRadar",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = startCmd;
            info.WorkingDirectory = dir;
            info.UseShellExecute = true;
            Process.Start(info);
            return 0;
        }
    }

    internal static class Uninstaller
    {
        internal static int Run(string baseDir, bool silent)
        {
            string target = ReadInstallLocation();
            bool ours = target != null
                && string.Equals(
                    Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar),
                    Path.GetFullPath(baseDir).TrimEnd(Path.DirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase);

            // A portable copy is not an install; deleting the folder the user
            // launched from would be a surprise, so refuse instead.
            if (!ours)
            {
                if (!silent)
                {
                    MessageBox.Show(
                        "This copy of DriverRadar is not installed, so there is nothing to remove.\n\n"
                        + "Use the entry in Apps & features, or delete the folder yourself.",
                        "DriverRadar",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
                return 0;
            }

            if (!silent)
            {
                DialogResult answer = MessageBox.Show(
                    "Remove DriverRadar from this PC?\n\n"
                    + target + "\n\n"
                    + "The app and its cached downloads in data\\ are deleted. Your installed drivers are not touched.",
                    "Remove DriverRadar",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button2);

                if (answer != DialogResult.Yes) return 0;
            }

            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            Shortcuts.Delete(Path.Combine(programs, "DriverRadar.lnk"));

            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            Shortcuts.Delete(Path.Combine(desktop, "DriverRadar.lnk"));

            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(Program.UninstallKeyPath, false);
            }
            catch
            {
                // Nothing registered: fine.
            }

            ScheduleDelete(target);
            return 0;
        }

        private static string ReadInstallLocation()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Program.UninstallKeyPath))
            {
                if (key == null) return null;
                return key.GetValue("InstallLocation") as string;
            }
        }

        private static void ScheduleDelete(string target)
        {
            // The running executable cannot delete its own folder, so a detached
            // shell waits for it to exit and then removes the tree.
            string script = Path.Combine(
                Path.GetTempPath(),
                "DriverRadar-uninstall-" + Guid.NewGuid().ToString("N") + ".cmd");

            File.WriteAllText(
                script,
                "@echo off\r\n"
                + "timeout /t 2 /nobreak >nul\r\n"
                + "rmdir /s /q \"" + target + "\"\r\n"
                + "del /f /q \"%~f0\"\r\n",
                Encoding.Default);

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = "cmd.exe";
            info.Arguments = "/c \"" + script + "\"";
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(info);
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly string baseDir;
        private readonly TextBox pathBox = new TextBox();
        private readonly CheckBox desktopBox = new CheckBox();
        private readonly Button installButton = new Button();
        private readonly Button closeButton = new Button();
        private readonly Button browseButton = new Button();
        private readonly Button finishButton = new Button();
        private readonly CheckBox launchBox = new CheckBox();
        private readonly ProgressBar progress = new ProgressBar();
        private readonly Label statusLabel = new Label();
        private readonly Label headline = new Label();
        private bool busy;

        internal SetupForm(string baseDir)
        {
            this.baseDir = baseDir;
            BuildUi();
        }

        private void BuildUi()
        {
            Text = "DriverRadar " + BuildInfo.Version + " Setup";
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.White;
            ClientSize = new Size(520, 340);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            Panel header = new Panel();
            header.Bounds = new Rectangle(0, 0, 520, 74);
            header.BackColor = Color.FromArgb(15, 23, 42);
            Controls.Add(header);

            Label title = new Label();
            title.Text = "DriverRadar";
            title.Font = new Font("Segoe UI Semibold", 16F, FontStyle.Bold);
            title.ForeColor = Color.White;
            title.AutoSize = true;
            title.Location = new Point(20, 12);
            header.Controls.Add(title);

            Label tagline = new Label();
            tagline.Text = "Windows driver scanner and updater  \u00b7  version " + BuildInfo.Version;
            tagline.ForeColor = Color.FromArgb(148, 163, 184);
            tagline.AutoSize = true;
            tagline.Location = new Point(22, 46);
            header.Controls.Add(tagline);

            headline.Text = "Install for this account";
            headline.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
            headline.AutoSize = true;
            headline.Location = new Point(20, 92);
            Controls.Add(headline);

            Label hint = new Label();
            hint.Text = "No administrator rights are needed to install. The app asks for them when it installs a driver.";
            hint.ForeColor = Color.FromArgb(71, 85, 105);
            hint.AutoSize = true;
            hint.Location = new Point(20, 114);
            Controls.Add(hint);

            Label folderLabel = new Label();
            folderLabel.Text = "Install folder";
            folderLabel.AutoSize = true;
            folderLabel.Location = new Point(20, 146);
            Controls.Add(folderLabel);

            pathBox.Bounds = new Rectangle(20, 166, 398, 24);
            pathBox.Text = Installer.DefaultTarget;
            Controls.Add(pathBox);

            browseButton.Text = "Browse\u2026";
            browseButton.Bounds = new Rectangle(426, 165, 74, 26);
            browseButton.Click += delegate { Browse(); };
            Controls.Add(browseButton);

            desktopBox.Text = "Create a Desktop shortcut (a Start Menu shortcut is always created)";
            desktopBox.Checked = true;
            desktopBox.AutoSize = true;
            desktopBox.Location = new Point(20, 202);
            Controls.Add(desktopBox);

            statusLabel.Bounds = new Rectangle(20, 230, 480, 20);
            statusLabel.Text = "Ready to install.";
            statusLabel.ForeColor = Color.FromArgb(71, 85, 105);
            Controls.Add(statusLabel);

            progress.Bounds = new Rectangle(20, 254, 480, 8);
            progress.Style = ProgressBarStyle.Marquee;
            progress.MarqueeAnimationSpeed = 0;
            Controls.Add(progress);

            installButton.Text = "Install";
            installButton.Bounds = new Rectangle(330, 288, 82, 30);
            installButton.Click += delegate { StartInstall(); };
            Controls.Add(installButton);

            closeButton.Text = "Cancel";
            closeButton.Bounds = new Rectangle(420, 288, 82, 30);
            closeButton.DialogResult = DialogResult.Cancel;
            Controls.Add(closeButton);

            launchBox.Text = "Launch DriverRadar now (it asks for administrator rights)";
            launchBox.Checked = true;
            launchBox.AutoSize = true;
            launchBox.Location = new Point(20, 294);
            launchBox.Visible = false;
            Controls.Add(launchBox);

            finishButton.Text = "Finish";
            finishButton.Bounds = new Rectangle(330, 288, 172, 30);
            finishButton.Visible = false;
            finishButton.Click += delegate
            {
                if (launchBox.Checked)
                {
                    string target = pathBox.Text.Trim();
                    Launcher.Run(target);
                }
                Close();
            };
            Controls.Add(finishButton);

            AcceptButton = installButton;
            CancelButton = closeButton;
        }

        private void Browse()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Choose where DriverRadar should be installed";
                dialog.SelectedPath = pathBox.Text;
                dialog.ShowNewFolderButton = true;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    // Install into a DriverRadar subfolder of whatever they picked,
                    // unless they picked one already.
                    string picked = dialog.SelectedPath;
                    pathBox.Text = string.Equals(
                        Path.GetFileName(picked.TrimEnd(Path.DirectorySeparatorChar)),
                        "DriverRadar",
                        StringComparison.OrdinalIgnoreCase)
                        ? picked
                        : Path.Combine(picked, "DriverRadar");
                }
            }
        }

        private void StartInstall()
        {
            if (busy) return;

            string target = pathBox.Text.Trim();
            if (target.Length == 0)
            {
                MessageBox.Show("Choose an install folder first.", "DriverRadar", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            busy = true;
            SetBusy(true);

            string status = Directory.Exists(target) && Installer.IsInstalled(target)
                ? "Updating the existing install (downloads in data\\ are kept)\u2026"
                : "Installing DriverRadar\u2026";
            statusLabel.Text = status;

            bool desktop = desktopBox.Checked;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Installer.Install(baseDir, target, desktop);
                    BeginInvoke(new Action(ShowFinished));
                }
                catch (Exception ex)
                {
                    BeginInvoke(new Action(delegate { ShowFailed(ex); }));
                }
            });
        }

        private void SetBusy(bool value)
        {
            pathBox.Enabled = !value;
            browseButton.Enabled = !value;
            desktopBox.Enabled = !value;
            installButton.Enabled = !value;
            closeButton.Enabled = !value;
            progress.MarqueeAnimationSpeed = value ? 30 : 0;
        }

        private void ShowFinished()
        {
            busy = false;
            progress.MarqueeAnimationSpeed = 0;
            statusLabel.Text = "DriverRadar " + BuildInfo.Version + " is installed.";
            statusLabel.ForeColor = Color.FromArgb(21, 128, 61);

            headline.Text = "You are all set";
            installButton.Visible = false;
            closeButton.Visible = false;
            launchBox.Visible = true;
            finishButton.Visible = true;
            AcceptButton = finishButton;
            CancelButton = null;
        }

        private void ShowFailed(Exception ex)
        {
            busy = false;
            SetBusy(false);
            progress.MarqueeAnimationSpeed = 0;
            statusLabel.Text = "Install failed.";
            statusLabel.ForeColor = Color.FromArgb(185, 28, 28);

            MessageBox.Show(
                "DriverRadar could not be installed.\n\n" + ex.Message,
                "DriverRadar setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
