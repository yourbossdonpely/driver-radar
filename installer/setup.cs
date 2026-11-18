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
        internal const string IconResource = "DriverRadar.icon.png";
        internal const string LicenseResource = "DriverRadar.LICENSE";
        internal const string LauncherName = "DriverRadar.exe";
        internal const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DriverRadar";
        internal const string ProjectUrl = "https://github.com/yourbossdonpely/driver-radar";
        internal const string AuthorName = "yourbossdonpely (Don Pely)";
        internal const string PublisherName = "yourbossdonpely";

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
                key.SetValue("Publisher", Program.PublisherName);
                key.SetValue("InstallLocation", target);
                key.SetValue("DisplayIcon", launcher + ",0");
                key.SetValue("UninstallString", "\"" + launcher + "\" --uninstall");
                key.SetValue("QuietUninstallString", "\"" + launcher + "\" --uninstall --silent");
                key.SetValue("URLInfoAbout", Program.ProjectUrl);
                key.SetValue("Contact", Program.AuthorName);
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

        // Header controls
        private readonly Panel headerPanel = new Panel();
        private readonly PictureBox logoBox = new PictureBox();
        private readonly Label titleLabel = new Label();
        private readonly Label taglineLabel = new Label();
        private readonly Label authorLabel = new Label();

        // Wizard Panels
        private readonly Panel licensePanel = new Panel();
        private readonly Panel optionsPanel = new Panel();
        private readonly Panel progressPanel = new Panel();
        private readonly Panel finishedPanel = new Panel();

        // Step 1: License Agreement controls
        private readonly TextBox licenseBox = new TextBox();
        private readonly RadioButton rbAccept = new RadioButton();
        private readonly RadioButton rbReject = new RadioButton();

        // Step 2: Options controls
        private readonly TextBox pathBox = new TextBox();
        private readonly Button browseButton = new Button();
        private readonly CheckBox desktopBox = new CheckBox();

        // Step 3: Progress controls
        private readonly Label statusLabel = new Label();
        private readonly ProgressBar progress = new ProgressBar();

        // Step 4: Finished controls
        private readonly CheckBox launchBox = new CheckBox();

        // Navigation controls
        private readonly Panel bottomPanel = new Panel();
        private readonly Button backButton = new Button();
        private readonly Button nextButton = new Button();
        private readonly Button cancelButton = new Button();

        private int currentStep = 1;
        private bool busy;

        internal SetupForm(string baseDir)
        {
            this.baseDir = baseDir;
            BuildUi();
            ShowStep(1);
        }

        private static Image GetEmbeddedLogo()
        {
            try
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                using (Stream stream = assembly.GetManifestResourceStream(Program.IconResource))
                {
                    if (stream != null) return Image.FromStream(stream);
                }
            }
            catch { }

            try
            {
                Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (icon != null) return icon.ToBitmap();
            }
            catch { }

            return null;
        }

        private static string GetLicenseContent()
        {
            try
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                using (Stream stream = assembly.GetManifestResourceStream(Program.LicenseResource))
                {
                    if (stream != null)
                    {
                        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                        {
                            return reader.ReadToEnd();
                        }
                    }
                }
            }
            catch { }

            return "MIT License\r\n\r\n"
                + "Copyright (c) 2026 yourbossdonpely (Don Pely) and DriverRadar contributors\r\n\r\n"
                + "Permission is hereby granted, free of charge, to any person obtaining a copy\r\n"
                + "of this software and associated documentation files (the \"Software\"), to deal\r\n"
                + "in the Software without restriction, including without limitation the rights\r\n"
                + "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\r\n"
                + "copies of the Software, and to permit persons to whom the Software is\r\n"
                + "furnished to do so, subject to the following conditions:\r\n\r\n"
                + "The above copyright notice and this permission notice shall be included in all\r\n"
                + "copies or substantial portions of the Software.\r\n\r\n"
                + "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\r\n"
                + "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\r\n"
                + "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\r\n"
                + "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\r\n"
                + "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\r\n"
                + "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\r\n"
                + "SOFTWARE.";
        }

        private void BuildUi()
        {
            Text = "DriverRadar " + BuildInfo.Version + " Setup";
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.White;
            ClientSize = new Size(540, 400);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            try
            {
                Icon appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (appIcon != null) Icon = appIcon;
            }
            catch { }

            // Header Panel
            headerPanel.Bounds = new Rectangle(0, 0, 540, 76);
            headerPanel.BackColor = Color.FromArgb(15, 23, 42);
            Controls.Add(headerPanel);

            Image logo = GetEmbeddedLogo();
            if (logo != null)
            {
                logoBox.Bounds = new Rectangle(16, 12, 52, 52);
                logoBox.SizeMode = PictureBoxSizeMode.Zoom;
                logoBox.Image = logo;
                headerPanel.Controls.Add(logoBox);
            }

            titleLabel.Text = "DriverRadar";
            titleLabel.Font = new Font("Segoe UI Semibold", 15F, FontStyle.Bold);
            titleLabel.ForeColor = Color.White;
            titleLabel.AutoSize = true;
            titleLabel.Location = new Point(76, 10);
            headerPanel.Controls.Add(titleLabel);

            taglineLabel.Text = "Windows driver scanner and updater  ·  v" + BuildInfo.Version;
            taglineLabel.ForeColor = Color.FromArgb(148, 163, 184);
            taglineLabel.AutoSize = true;
            taglineLabel.Location = new Point(78, 36);
            headerPanel.Controls.Add(taglineLabel);

            authorLabel.Text = "Developed by " + Program.AuthorName;
            authorLabel.Font = new Font("Segoe UI", 8.25F);
            authorLabel.ForeColor = Color.FromArgb(56, 189, 248);
            authorLabel.AutoSize = true;
            authorLabel.Location = new Point(78, 54);
            headerPanel.Controls.Add(authorLabel);

            // Wizard Panels bounds
            Rectangle contentArea = new Rectangle(0, 76, 540, 264);
            licensePanel.Bounds = contentArea;
            optionsPanel.Bounds = contentArea;
            progressPanel.Bounds = contentArea;
            finishedPanel.Bounds = contentArea;

            Controls.Add(licensePanel);
            Controls.Add(optionsPanel);
            Controls.Add(progressPanel);
            Controls.Add(finishedPanel);

            BuildLicensePanel();
            BuildOptionsPanel();
            BuildProgressPanel();
            BuildFinishedPanel();

            // Bottom Navigation Panel
            bottomPanel.Bounds = new Rectangle(0, 340, 540, 60);
            bottomPanel.BackColor = Color.FromArgb(248, 250, 252);
            Controls.Add(bottomPanel);

            Panel line = new Panel();
            line.Bounds = new Rectangle(0, 0, 540, 1);
            line.BackColor = Color.FromArgb(226, 232, 240);
            bottomPanel.Controls.Add(line);

            backButton.Text = "< &Back";
            backButton.Bounds = new Rectangle(264, 15, 80, 28);
            backButton.Click += delegate { NavigateBack(); };
            bottomPanel.Controls.Add(backButton);

            nextButton.Text = "&Next >";
            nextButton.Bounds = new Rectangle(350, 15, 84, 28);
            nextButton.Click += delegate { NavigateNext(); };
            bottomPanel.Controls.Add(nextButton);

            cancelButton.Text = "Cancel";
            cancelButton.Bounds = new Rectangle(440, 15, 84, 28);
            cancelButton.DialogResult = DialogResult.Cancel;
            cancelButton.Click += delegate { Close(); };
            bottomPanel.Controls.Add(cancelButton);

            AcceptButton = nextButton;
            CancelButton = cancelButton;
        }

        private void BuildLicensePanel()
        {
            Label heading = new Label();
            heading.Text = "License Agreement";
            heading.Font = new Font("Segoe UI Semibold", 10.5F, FontStyle.Bold);
            heading.Location = new Point(22, 10);
            heading.AutoSize = true;
            licensePanel.Controls.Add(heading);

            Label sub = new Label();
            sub.Text = "Please read the following license agreement. You must accept the terms to continue.";
            sub.ForeColor = Color.FromArgb(71, 85, 105);
            sub.Location = new Point(22, 30);
            sub.AutoSize = true;
            licensePanel.Controls.Add(sub);

            licenseBox.Bounds = new Rectangle(22, 52, 496, 142);
            licenseBox.Multiline = true;
            licenseBox.ReadOnly = true;
            licenseBox.ScrollBars = ScrollBars.Vertical;
            licenseBox.BackColor = Color.White;
            licenseBox.Font = new Font("Segoe UI", 8.5F);
            licenseBox.Text = GetLicenseContent();
            licensePanel.Controls.Add(licenseBox);

            rbAccept.Text = "I &accept the agreement";
            rbAccept.Location = new Point(24, 202);
            rbAccept.AutoSize = true;
            rbAccept.CheckedChanged += delegate
            {
                nextButton.Enabled = rbAccept.Checked;
            };
            licensePanel.Controls.Add(rbAccept);

            rbReject.Text = "I do &not accept the agreement";
            rbReject.Checked = true;
            rbReject.Location = new Point(24, 226);
            rbReject.AutoSize = true;
            licensePanel.Controls.Add(rbReject);
        }

        private void BuildOptionsPanel()
        {
            Label heading = new Label();
            heading.Text = "Select Destination Location";
            heading.Font = new Font("Segoe UI Semibold", 10.5F, FontStyle.Bold);
            heading.Location = new Point(22, 10);
            heading.AutoSize = true;
            optionsPanel.Controls.Add(heading);

            Label sub = new Label();
            sub.Text = "Where should DriverRadar be installed on your computer?";
            sub.ForeColor = Color.FromArgb(71, 85, 105);
            sub.Location = new Point(22, 30);
            sub.AutoSize = true;
            optionsPanel.Controls.Add(sub);

            Label folderLabel = new Label();
            folderLabel.Text = "Install folder:";
            folderLabel.Location = new Point(22, 60);
            folderLabel.AutoSize = true;
            optionsPanel.Controls.Add(folderLabel);

            pathBox.Bounds = new Rectangle(22, 80, 412, 24);
            pathBox.Text = Installer.DefaultTarget;
            optionsPanel.Controls.Add(pathBox);

            browseButton.Text = "Browse\u2026";
            browseButton.Bounds = new Rectangle(440, 79, 78, 26);
            browseButton.Click += delegate { Browse(); };
            optionsPanel.Controls.Add(browseButton);

            Label hint = new Label();
            hint.Text = "No administrator rights are needed to install. Driver updates ask for elevation when needed.";
            hint.ForeColor = Color.FromArgb(71, 85, 105);
            hint.Location = new Point(22, 118);
            hint.Size = new Size(496, 32);
            optionsPanel.Controls.Add(hint);

            desktopBox.Text = "Create a Desktop shortcut (Start Menu shortcut is always created)";
            desktopBox.Checked = true;
            desktopBox.Location = new Point(22, 160);
            desktopBox.AutoSize = true;
            optionsPanel.Controls.Add(desktopBox);

            Label pubInfo = new Label();
            pubInfo.Text = "Publisher: " + Program.AuthorName + "  ·  " + Program.ProjectUrl;
            pubInfo.ForeColor = Color.FromArgb(100, 116, 139);
            pubInfo.Font = new Font("Segoe UI", 8F);
            pubInfo.Location = new Point(22, 205);
            pubInfo.AutoSize = true;
            optionsPanel.Controls.Add(pubInfo);
        }

        private void BuildProgressPanel()
        {
            Label heading = new Label();
            heading.Text = "Installing DriverRadar\u2026";
            heading.Font = new Font("Segoe UI Semibold", 10.5F, FontStyle.Bold);
            heading.Location = new Point(22, 24);
            heading.AutoSize = true;
            progressPanel.Controls.Add(heading);

            statusLabel.Bounds = new Rectangle(22, 64, 496, 20);
            statusLabel.Text = "Preparing installation files\u2026";
            statusLabel.ForeColor = Color.FromArgb(71, 85, 105);
            progressPanel.Controls.Add(statusLabel);

            progress.Bounds = new Rectangle(22, 92, 496, 18);
            progress.Style = ProgressBarStyle.Marquee;
            progress.MarqueeAnimationSpeed = 30;
            progressPanel.Controls.Add(progress);

            Label info = new Label();
            info.Text = "Please wait while DriverRadar extracts its application payload, creates desktop and Start Menu shortcuts, and registers with Windows.";
            info.ForeColor = Color.FromArgb(100, 116, 139);
            info.Location = new Point(22, 130);
            info.Size = new Size(496, 40);
            progressPanel.Controls.Add(info);
        }

        private void BuildFinishedPanel()
        {
            Label heading = new Label();
            heading.Text = "Completing the DriverRadar Setup Wizard";
            heading.Font = new Font("Segoe UI Semibold", 12F, FontStyle.Bold);
            heading.Location = new Point(22, 24);
            heading.AutoSize = true;
            finishedPanel.Controls.Add(heading);

            Label finishedText = new Label();
            finishedText.Text = "DriverRadar " + BuildInfo.Version + " has been successfully installed on your computer.\r\n\r\n"
                + "A Start Menu shortcut and Desktop shortcut have been created. Click Finish to exit Setup.";
            finishedText.ForeColor = Color.FromArgb(51, 65, 85);
            finishedText.Location = new Point(22, 64);
            finishedText.Size = new Size(496, 60);
            finishedPanel.Controls.Add(finishedText);

            launchBox.Text = "Launch DriverRadar now (it asks for administrator rights)";
            launchBox.Checked = true;
            launchBox.Location = new Point(24, 148);
            launchBox.AutoSize = true;
            finishedPanel.Controls.Add(launchBox);
        }

        private void ShowStep(int step)
        {
            currentStep = step;
            licensePanel.Visible = (step == 1);
            optionsPanel.Visible = (step == 2);
            progressPanel.Visible = (step == 3);
            finishedPanel.Visible = (step == 4);

            if (step == 1)
            {
                backButton.Visible = true;
                backButton.Enabled = false;
                nextButton.Visible = true;
                nextButton.Text = "&Next >";
                nextButton.Enabled = rbAccept.Checked;
                cancelButton.Visible = true;
                cancelButton.Enabled = true;
                AcceptButton = nextButton;
            }
            else if (step == 2)
            {
                backButton.Visible = true;
                backButton.Enabled = true;
                nextButton.Visible = true;
                nextButton.Text = "&Install";
                nextButton.Enabled = true;
                cancelButton.Visible = true;
                cancelButton.Enabled = true;
                AcceptButton = nextButton;
            }
            else if (step == 3)
            {
                backButton.Visible = true;
                backButton.Enabled = false;
                nextButton.Visible = true;
                nextButton.Enabled = false;
                cancelButton.Visible = true;
                cancelButton.Enabled = false;
            }
            else if (step == 4)
            {
                backButton.Visible = false;
                cancelButton.Visible = false;
                nextButton.Visible = true;
                nextButton.Text = "&Finish";
                nextButton.Enabled = true;
                nextButton.Bounds = new Rectangle(440, 15, 84, 28);
                AcceptButton = nextButton;
            }
        }

        private void NavigateBack()
        {
            if (currentStep == 2)
            {
                ShowStep(1);
            }
        }

        private void NavigateNext()
        {
            if (currentStep == 1)
            {
                ShowStep(2);
            }
            else if (currentStep == 2)
            {
                StartInstall();
            }
            else if (currentStep == 4)
            {
                if (launchBox.Checked)
                {
                    string target = pathBox.Text.Trim();
                    Launcher.Run(target);
                }
                Close();
            }
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
            ShowStep(3);

            string status = Directory.Exists(target) && Installer.IsInstalled(target)
                ? "Updating existing install (downloads in data\\ are preserved)\u2026"
                : "Installing DriverRadar payload\u2026";
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

        private void ShowFinished()
        {
            busy = false;
            progress.MarqueeAnimationSpeed = 0;
            ShowStep(4);
        }

        private void ShowFailed(Exception ex)
        {
            busy = false;
            progress.MarqueeAnimationSpeed = 0;
            ShowStep(2);

            MessageBox.Show(
                "DriverRadar could not be installed.\n\n" + ex.Message,
                "DriverRadar setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
