using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class CompletionBar : Control {
    int completed, total = 1;
    public CompletionBar() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true); }
    public void SetProgress(int count, int countTotal) {
        countTotal = Math.Max(1, countTotal); count = Math.Max(0, Math.Min(countTotal, count));
        if (count == completed && countTotal == total) return;
        completed = count; total = countTotal; Invalidate();
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        using (var track = new SolidBrush(Color.FromArgb(225, 231, 240))) e.Graphics.FillRectangle(track, ClientRectangle);
        int width = (int)Math.Floor((double)ClientSize.Width * completed / total);
        if (width > 0) using (var fill = new SolidBrush(Color.FromArgb(39, 96, 205))) e.Graphics.FillRectangle(fill, 0, 0, width, ClientSize.Height);
    }
}

internal sealed class RunnerWindow : Form {
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly HttpClient http = new HttpClient();
    Process backend;
    string endpoint, folder, logText = "", previewPath = "", excelPath = "", excelHash = "";
    bool ready, polling, operation, active, resumable, closing, closed, loadedRun, generatingResults, canGenerateResults, canHandleManual, pauseRequested, selectionChosen, executableInitialized;
    readonly Timer timer = new Timer { Interval = 750 };
    readonly TextBox executable = new TextBox(), account = new TextBox(), logs = new TextBox(), excelFile = new TextBox();
    readonly Label timingHint = new Label();
    readonly NumericUpDown port = new NumericUpDown { Minimum = 1024, Maximum = 65535, Value = 9223 };
    readonly ComboBox dataset = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly CheckBox clean = new CheckBox { Text = "我已核验正式测评账号的独立初始状态（工具不清理记忆）", AutoSize = true };
    readonly Label connection = new Label(), headline = new Label(), step = new Label(), detail = new Label(), note = new Label(), currentFileLabel = new Label(), nextFileLabel = new Label();
    readonly ToolTip hints = new ToolTip();
    readonly CompletionBar progress = new CompletionBar();
    readonly Button launch = new Button(), check = new Button(), start = new Button(), runControl = new Button(), review = new Button(), openFolder = new Button(), exportCurrent = new Button(), generateExcel = new Button(), previewDataset = new Button(), openResult = new Button(), openBackups = new Button();
    Dictionary<string, object> view;

    static object Value(Dictionary<string, object> obj, string key) { object v; return obj != null && obj.TryGetValue(key, out v) ? v : null; }
    static string TextOf(Dictionary<string, object> obj, string key) { return Convert.ToString(Value(obj, key)); }
    static bool BoolOf(Dictionary<string, object> obj, string key) { return Value(obj, key) is bool && (bool)Value(obj, key); }
    static Dictionary<string, object> ObjectOf(Dictionary<string, object> obj, string key) { return Value(obj, key) as Dictionary<string, object>; }
    static int IntOf(Dictionary<string, object> obj, string key) { return Convert.ToInt32(Value(obj, key) ?? 0); }
    static string TimeOf(object ms) { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Convert.ToDouble(ms)).ToLocalTime().ToString("MM-dd HH:mm:ss"); }
    static void StyleButton(Button b, string text, bool primary) {
        b.Text = text; b.Height = 34; b.Width = 108; b.Margin = new Padding(0, 0, 10, 0);
        b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderColor = Color.FromArgb(207, 216, 229);
        b.BackColor = primary ? Color.FromArgb(39, 96, 205) : Color.White;
        b.ForeColor = primary ? Color.White : Color.FromArgb(38, 54, 76);
        b.Cursor = Cursors.Hand;
    }
    public RunnerWindow() {
        Text = "豆包测评执行器 V1.8.1"; ClientSize = new Size(980, 840); MinimumSize = new Size(930, 780);
        json.MaxJsonLength = 20 * 1024 * 1024;
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(244, 247, 251);
        Font = new Font("Microsoft YaHei UI", 9F); AutoScaleMode = AutoScaleMode.Dpi;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24, 18, 24, 18), ColumnCount = 1, RowCount = 9 };
        foreach (int size in new int[] { 58, 182, 32, 40, 132, 80 }) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, size));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        layout.RowStyles[2].SizeType = SizeType.AutoSize;
        Controls.Add(layout);
        var header = new Panel { Dock = DockStyle.Fill };
        header.Controls.Add(new Label { Text = "豆包测评执行器", Font = new Font(Font.FontFamily, 18F, FontStyle.Bold), ForeColor = Color.FromArgb(27, 44, 68), AutoSize = true, Location = new Point(0, 0) });
        timingHint.Text = "确认回答结束 → 测评间隔 30 秒 → 准备下一条 · 页面异常自动恢复"; timingHint.AutoSize = true; timingHint.ForeColor = Color.FromArgb(101, 115, 136); timingHint.Location = new Point(2, 38); header.Controls.Add(timingHint);
        layout.Controls.Add(header, 0, 0);
        var config = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, RowCount = 4, BackColor = Color.White, Padding = new Padding(12) };
        config.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78)); config.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        config.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 62)); config.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80)); config.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 124));
        for (int i = 0; i < 4; i++) config.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        config.Controls.Add(new Label { Text = "豆包路径", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
        executable.Text = Environment.GetEnvironmentVariable("DOUBAO_EXECUTABLE") ?? ""; executable.Dock = DockStyle.Fill; executable.AccessibleName = "豆包程序路径";
        // A local selection/edit owns this field, even while the initial status request is in flight.
        executable.TextChanged += delegate { executableInitialized = true; };
        config.Controls.Add(executable, 1, 0); config.SetColumnSpan(executable, 3);
        var browse = new Button { Text = "选择程序", Dock = DockStyle.Fill }; config.Controls.Add(browse, 4, 0);
        browse.Click += delegate { using (var dialog = new OpenFileDialog { Filter = "豆包程序|Doubao.exe|可执行程序|*.exe", Title = "选择 Doubao.exe" }) { if (dialog.ShowDialog() == DialogResult.OK) executable.Text = dialog.FileName; } };
        config.Controls.Add(new Label { Text = "测试流程", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 1);
        dataset.Items.AddRange(new object[] { "旧豆包 B 正式测评（54 条，需独立初始状态）", "连通性测试（4 条，不含测评数据）", "旧豆包 B 长流程技术回归（54 条，不计测评分）", "Excel测评集 · 技术回归（按表执行）", "Excel测评集 · 正式测评（需独立初始状态）" }); dataset.SelectedIndex = 0;
        dataset.Dock = DockStyle.Fill; dataset.AccessibleName = "测试流程"; config.Controls.Add(dataset, 1, 1);
        config.Controls.Add(new Label { Text = "端口", AutoSize = true, Anchor = AnchorStyles.Left }, 2, 1);
        port.Dock = DockStyle.Fill; port.AccessibleName = "调试端口"; config.Controls.Add(port, 3, 1);
        StyleButton(check, "检查连接", false); check.Dock = DockStyle.Fill; check.AccessibleName = "检查连接"; config.Controls.Add(check, 4, 1);
        config.Controls.Add(new Label { Text = "当前账号", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 2);
        account.ReadOnly = true; account.Dock = DockStyle.Fill; account.AccessibleName = "当前豆包账号"; config.Controls.Add(account, 1, 2);
        connection.Text = "尚未检查"; connection.AutoSize = true; connection.Anchor = AnchorStyles.Left; config.Controls.Add(connection, 2, 2); config.SetColumnSpan(connection, 2);
        StyleButton(launch, "启动豆包", false); launch.Dock = DockStyle.Fill; config.Controls.Add(launch, 4, 2);
        config.Controls.Add(new Label { Text = "待运行文件", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 3);
        excelFile.ReadOnly = true; excelFile.Dock = DockStyle.Fill; excelFile.Text = "尚未选择；内置流程不需要"; config.Controls.Add(excelFile, 1, 3); config.SetColumnSpan(excelFile, 3);
        StyleButton(previewDataset, "选取/校验", false); previewDataset.AccessibleName = "测评集校验预览"; previewDataset.Dock = DockStyle.Fill; config.Controls.Add(previewDataset, 4, 3);
        layout.Controls.Add(config, 0, 1);
        clean.Margin = Padding.Empty;
        var cleanPanel = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(0, 6, 0, 6) };
        cleanPanel.Controls.Add(clean); layout.Controls.Add(cleanPanel, 0, 2);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        StyleButton(start, "开始新一轮", true); start.Width = 144; StyleButton(runControl, "继续本轮", true); runControl.Width = 160;
        StyleButton(review, "核对后重试", false); review.Width = 126;
        start.AccessibleName = "开始新一轮"; runControl.AccessibleName = "本轮执行操作"; review.AccessibleName = "核对后重试";
        StyleButton(exportCurrent, "导出已加载对话", false); exportCurrent.Width = 154; exportCurrent.AccessibleName = "导出已加载对话";
        foreach (var b in new Button[] { start, runControl, review, exportCurrent }) actions.Controls.Add(b);
        layout.Controls.Add(actions, 0, 3);
        var statusPanel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Padding = new Padding(0, 6, 0, 6) };
        foreach (int height in new int[] { 30, 24, 24, 28, 12 }) statusPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        headline.Text = "正在准备运行环境…"; headline.Font = new Font(Font.FontFamily, 12F, FontStyle.Bold);
        currentFileLabel.Text = "本轮：尚未建立任务"; nextFileLabel.Text = "待运行：尚未选择测评集";
        step.Text = "尚未开始";
        foreach (var label in new Label[] { headline, currentFileLabel, nextFileLabel, step }) { label.Dock = DockStyle.Fill; label.AutoEllipsis = true; label.TextAlign = ContentAlignment.MiddleLeft; }
        progress.Dock = DockStyle.Fill; progress.AccessibleName = "本轮已处理步骤进度";
        statusPanel.Controls.Add(headline, 0, 0); statusPanel.Controls.Add(currentFileLabel, 0, 1); statusPanel.Controls.Add(nextFileLabel, 0, 2); statusPanel.Controls.Add(step, 0, 3); statusPanel.Controls.Add(progress, 0, 4); layout.Controls.Add(statusPanel, 0, 4);
        detail.Dock = DockStyle.Fill; detail.ForeColor = Color.FromArgb(95, 109, 131); detail.Text = "首次运行请先检查连接。正式流程不会自动开始。";
        detail.Padding = new Padding(0, 8, 0, 0); layout.Controls.Add(detail, 0, 5);
        logs.Multiline = true; logs.ReadOnly = true; logs.ScrollBars = ScrollBars.Vertical; logs.Dock = DockStyle.Fill;
        logs.Font = new Font("Microsoft YaHei UI", 9F); logs.BackColor = Color.White; logs.BorderStyle = BorderStyle.FixedSingle; logs.AccessibleName = "运行日志";
        layout.Controls.Add(logs, 0, 6);
        note.Text = "本轮尚未生成结果。"; note.Dock = DockStyle.Fill; note.AutoEllipsis = true; note.TextAlign = ContentAlignment.MiddleLeft; note.ForeColor = detail.ForeColor; layout.Controls.Add(note, 0, 7);
        StyleButton(openResult, "打开结果 Excel", false); openResult.Width = 148; openResult.AccessibleName = "打开本轮已有结果Excel";
        StyleButton(openBackups, "打开会话备份", false); openBackups.Width = 148;
        StyleButton(generateExcel, "生成当前进度结果", false); generateExcel.Width = 176; generateExcel.AccessibleName = "生成当前进度结果";
        StyleButton(openFolder, "打开运行记录", false); openFolder.Width = 134;
        var resultActions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 4, 0, 0) };
        foreach (var button in new Button[] { openResult, openBackups, generateExcel, openFolder }) resultActions.Controls.Add(button);
        layout.Controls.Add(resultActions, 0, 8);
        dataset.SelectedIndexChanged += delegate { clean.Enabled = dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4;
            timingHint.Text = dataset.SelectedIndex >= 3 ? "确认回答结束 → 按Excel每行等待秒数 → 下一步骤 · MANUAL由人工处理" : "确认回答结束 → 测评间隔 30 秒 → 准备下一条 · 页面异常自动恢复";
            UpdateSelectionLabels(); };
        check.Click += async delegate { await Command("/check", Options()); };
        launch.Click += async delegate { await Command("/launch", Options()); };
        start.Click += async delegate {
            if ((dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4) && !clean.Checked) { MessageBox.Show(this, "请先核验正式测评账号初始状态，并勾选确认。", "开始前检查"); return; }
            if (dataset.SelectedIndex >= 3 && String.IsNullOrEmpty(excelPath)) { MessageBox.Show(this, "请先选取、校验Excel，并点击“用于本轮执行”。", "尚未选择测评集"); return; }
            if (resumable && MessageBox.Show(this, "当前本轮：" + CurrentRunName() + "\n待运行：" + SelectedInputName() + "\n\n将新建独立运行记录，旧进度保留；已发送到豆包的内容不会被撤回，也不会自动清理记忆。确定开始新一轮？", "新建运行", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            await Command("/start", BuildStartOptions());
        };
        runControl.Click += async delegate {
            if (active) await Command("/pause", BuildResumeOptions());
            else if (canHandleManual) await HandleManual();
            else if (resumable) await Command("/resume", BuildResumeOptions());
        };
        review.Click += async delegate {
            if (MessageBox.Show(this, "请先在豆包中核对：上一条消息确实没有发送。此操作允许重新尝试该条，并记录人工处理。确定未发送？", "核对发送状态", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes) await Command("/retry-not-sent", new Dictionary<string, object>());
        };
        openFolder.Click += delegate { OpenExistingPath(folder, true); };
        openResult.Click += delegate { var result = ObjectOf(ObjectOf(view, "artifacts"), "result"); if (BoolOf(result, "available")) OpenExistingPath(CurrentResultPath(), false); };
        openBackups.Click += delegate { OpenBackupFolders(); };
        exportCurrent.Click += async delegate {
            if (!ready || operation || active) return;
            operation = true; SetButtons(false, active, false);
            try {
                var response = await Request("/export-current", Options()); var result = ObjectOf(response, "result");
                string exportFolder = TextOf(result, "directory");
                MessageBox.Show(this, "已保存当前已加载内容：用户 " + IntOf(result, "user") + " 条，豆包 " + IntOf(result, "assistant") + " 条。\n\n历史完整性未验证；本版没有滚动加载更早消息。\n\n文件夹：\n" + exportFolder + "\n\n请打开 conversation.md 核对正文、角色和顺序。", "当前已加载对话已保存", MessageBoxButtons.OK, MessageBoxIcon.Information);
                if (Directory.Exists(exportFolder)) Process.Start(new ProcessStartInfo(exportFolder) { UseShellExecute = true });
            } catch (Exception error) { MessageBox.Show(this, error.Message, "对话导出未完成", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            finally { operation = false; }
            await RefreshState();
        };
        generateExcel.Click += async delegate {
            if (!ready || operation || generatingResults || !canGenerateResults) return;
            generatingResults = true; generateExcel.Text = "正在生成…"; SetButtons(false, active, false);
            try {
                var response = await Request("/generate-results", new Dictionary<string, object>()); var result = ObjectOf(response, "result");
                string copyInfo = String.IsNullOrEmpty(TextOf(result, "sourceFile")) ? "" : "\n原Excel目录副本：\n" + TextOf(result, "sourceFile") + (TextOf(result, "copyStatus") == "failed" ? "\n副本未完成：" + TextOf(result, "copyError") + "；再次点击结果按钮补存。" : "\n两份Excel内容一致。");
                string resultLabel = TextOf(result, "artifactKind") == "final" ? "全流程结果" : "阶段结果（当前已完成部分）";
                MessageBox.Show(this, "已生成" + resultLabel + "，原模板未改动。\n\n已保存回复 " + IntOf(result, "savedReplies") + " / " + IntOf(result, "totalRows") + " 条；问题回答 " + IntOf(result, "questionsFilled") + " / " + IntOf(result, "questionsTotal") + " 条；跳过 " + IntOf(result, "skippedRows") + " 条。\n已完成不代表评分通过；长回答可通过编辑栏查看。\n\n运行记录中的结果：\n" + TextOf(result, "file") + copyInfo, "结果表已生成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            } catch (Exception error) { MessageBox.Show(this, error.Message, "结果表未生成", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            finally { generatingResults = false; generateExcel.Text = "生成当前进度结果"; }
            await RefreshState();
        };
        previewDataset.Click += async delegate {
            if (!ready || operation || active || generatingResults) return;
            operation = true; SetButtons(false, active, false);
            try {
                string initialPath = String.IsNullOrEmpty(previewPath) ? TextOf(ObjectOf(view, "resultGeneration"), "template") : previewPath;
                using (var preview = new DatasetPreviewWindow(initialPath, async path => {
                    var response = await Request("/preview-dataset", new Dictionary<string, object> { { "filePath", path } });
                    return ObjectOf(response, "result");
                })) { preview.ShowDialog(this); previewPath = preview.SelectedFilePath;
                    if (preview.UseForExecution && preview.ValidatedReport != null) BindExcelSelection(preview.ValidatedReport);
                }
            } finally { operation = false; }
            await RefreshState();
        };
        timer.Tick += async delegate { await RefreshState(); };
        Shown += async delegate { await Boot(); };
        FormClosing += OnClosing;
        FormClosed += delegate { hints.Dispose(); };
        SetButtons(false, false, false);
    }
    Dictionary<string, object> CurrentRun() { return ObjectOf(view, "run"); }
    string CurrentResultPath() { return TextOf(ObjectOf(ObjectOf(view, "artifacts"), "result"), "file"); }
    string SelectedDatasetId() { return dataset.SelectedIndex >= 3 ? "excel" : dataset.SelectedIndex == 1 ? "smoke" : "doubao-b"; }
    string SelectedPurpose() { return dataset.SelectedIndex == 2 || dataset.SelectedIndex == 3 ? "technical_regression" : "formal_evaluation"; }
    string SelectedInputName() { return dataset.SelectedIndex >= 3 ? (String.IsNullOrEmpty(excelPath) ? "尚未选择Excel" : Path.GetFileName(excelPath)) : Convert.ToString(dataset.SelectedItem); }
    string CurrentRunName() { var run = CurrentRun(); return run == null ? "尚未建立任务" : TextOf(run, "datasetId") == "excel" ? TextOf(run, "inputName") : TextOf(run, "datasetId") == "smoke" ? "4条连通性测试" : "旧豆包B固定流程"; }
    static bool SamePath(string left, string right) {
        try { return String.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase); }
        catch { return String.Equals(left, right, StringComparison.OrdinalIgnoreCase); }
    }
    bool SelectionDiffers() {
        var run = CurrentRun(); if (run == null) return false;
        if (SelectedDatasetId() != TextOf(run, "datasetId") || (SelectedDatasetId() != "smoke" && SelectedPurpose() != TextOf(run, "purpose"))) return true;
        return SelectedDatasetId() == "excel" && (!SamePath(excelPath, TextOf(run, "inputPath")) || excelHash != TextOf(run, "inputHash"));
    }
    void UpdateSelectionLabels() {
        var run = CurrentRun();
        currentFileLabel.Text = "本轮：" + CurrentRunName() + (run == null ? "" : " · " + (TextOf(run, "purpose") == "technical_regression" ? "技术回归" : TextOf(run, "datasetId") == "smoke" ? "连通性测试" : "正式测评"));
        nextFileLabel.Text = "待运行：" + SelectedInputName() + (run == null ? "" : SelectionDiffers() ? " · 与本轮不同，开始将新建记录；继续仍恢复本轮" : " · 与本轮相同，继续将恢复原进度");
        nextFileLabel.ForeColor = SelectionDiffers() ? Color.FromArgb(145, 99, 37) : Color.FromArgb(95, 109, 131);
        hints.SetToolTip(currentFileLabel, TextOf(run, "inputPath") + "\n运行编号：" + TextOf(run, "id"));
        hints.SetToolTip(nextFileLabel, dataset.SelectedIndex >= 3 ? excelPath : SelectedInputName());
        start.Text = SelectionDiffers() ? "用待运行项新建" : "开始新一轮";
    }
    void BindExcelSelection(Dictionary<string, object> report) {
        var file = ObjectOf(report, "file");
        if (!BoolOf(report, "valid") || String.IsNullOrEmpty(TextOf(file, "path")) || String.IsNullOrEmpty(TextOf(file, "sha256"))) throw new Exception("请先完成校验，再选择用于执行。");
        excelPath = TextOf(file, "path"); excelHash = TextOf(file, "sha256"); excelFile.Text = excelPath; selectionChosen = true;
        clean.Checked = false; dataset.SelectedIndex = 3; UpdateSelectionLabels();
    }
    Dictionary<string, object> BuildStartOptions() {
        var opts = Options(); opts["datasetId"] = SelectedDatasetId(); opts["purpose"] = SelectedPurpose();
        opts["acknowledgeExistingMemory"] = dataset.SelectedIndex == 2 || dataset.SelectedIndex == 3;
        opts["cleanDeclared"] = (dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4) && clean.Checked; opts["abandon"] = resumable;
        opts["excelPath"] = excelPath; opts["excelHash"] = excelHash; opts["expectedPreviousRunId"] = TextOf(CurrentRun(), "id"); return opts;
    }
    Dictionary<string, object> BuildResumeOptions() { return new Dictionary<string, object> { { "expectedRunId", TextOf(CurrentRun(), "id") } }; }
    async Task HandleManual() {
        if (!ready || operation || active || !canHandleManual) return;
        operation = true; SetButtons(false, active, false);
        try { using (var window = new ManualStepWindow(async () => ObjectOf(await Request("/manual-details", new Dictionary<string, object>()), "result"),
            async input => ObjectOf(await Request("/manual-submit", input), "result"))) window.ShowDialog(this); }
        finally { operation = false; }
        await RefreshState();
    }
    void OpenExistingPath(string path, bool directory) {
        try {
            if (String.IsNullOrEmpty(path) || !(directory ? Directory.Exists(path) : File.Exists(path))) throw new Exception("本轮文件或目录已移动、删除或尚未生成。请打开运行记录核对；查看操作不会重新生成结果。");
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        } catch (Exception error) { MessageBox.Show(this, error.Message, "未能打开本轮文件", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }
    List<Dictionary<string, object>> BackupFolders() {
        var result = new List<Dictionary<string, object>>(); var entries = Value(ObjectOf(view, "artifacts"), "backups") as IEnumerable;
        if (entries != null) foreach (object entry in entries) { var item = entry as Dictionary<string, object>; if (item != null) result.Add(item); }
        return result;
    }
    void OpenBackupFolders() {
        var folders = BackupFolders(); if (folders.Count == 1) { OpenExistingPath(TextOf(folders[0], "path"), true); return; }
        if (folders.Count == 0) return;
        var menu = new ContextMenuStrip();
        foreach (var entry in folders) { string path = TextOf(entry, "path"); var item = new ToolStripMenuItem(TextOf(entry, "label")); item.Click += delegate { OpenExistingPath(path, true); }; menu.Items.Add(item); }
        menu.Closed += delegate { menu.Dispose(); }; menu.Show(openBackups, new Point(0, openBackups.Height));
    }
    Dictionary<string, object> Options() { return new Dictionary<string, object> { { "port", (int)port.Value }, { "executable", executable.Text }, { "account", account.Text } }; }
    string NodePath() {
        foreach (var path in new string[] { Path.Combine(root, "node.exe"), Environment.GetEnvironmentVariable("NODE_EXECUTABLE") ?? "" }) if (File.Exists(path)) return path;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) { try { string path = Path.Combine(dir.Trim().Trim('"'), "node.exe"); if (File.Exists(path)) return path; } catch { } }
        throw new Exception("未找到 Node.js。请安装 Node.js 22.15 或更新版本后重试。");
    }
    async Task Boot() {
        try {
            string token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            var info = new ProcessStartInfo(NodePath(), "\"" + Path.Combine(root, "server.mjs") + "\"") {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            info.EnvironmentVariables["DOUBAO_RUNNER_TOKEN"] = token;
            info.EnvironmentVariables["DOUBAO_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
            backend = Process.Start(info);
            Task<string> lineTask = backend.StandardOutput.ReadLineAsync();
            if (await Task.WhenAny(lineTask, Task.Delay(15000)) != lineTask) throw new Exception("执行服务启动超时，请查看启动错误日志。");
            string line = await lineTask;
            if (String.IsNullOrWhiteSpace(line)) throw new Exception(await backend.StandardError.ReadToEndAsync());
            var hello = json.Deserialize<Dictionary<string, object>>(line);
            endpoint = "http://127.0.0.1:" + IntOf(hello, "port");
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token); http.Timeout = TimeSpan.FromSeconds(150);
            ready = true; await RefreshState(); timer.Start();
        } catch (Exception error) {
            headline.Text = "启动失败"; detail.Text = error.Message;
            File.AppendAllText(Path.Combine(root, "启动错误.log"), DateTime.Now + " " + error + Environment.NewLine, Encoding.UTF8);
            MessageBox.Show(this, error.Message, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
    async Task<Dictionary<string, object>> Request(string path, Dictionary<string, object> payload) {
        HttpResponseMessage response;
        if (payload == null) response = await http.GetAsync(endpoint + path);
        else response = await http.PostAsync(endpoint + path, new StringContent(json.Serialize(payload), Encoding.UTF8, "application/json"));
        string text = await response.Content.ReadAsStringAsync();
        var value = json.Deserialize<Dictionary<string, object>>(text);
        if (!response.IsSuccessStatusCode) throw new Exception(TextOf(value, "error"));
        return value;
    }
    async Task Command(string path, Dictionary<string, object> payload) {
        if (!ready || operation) return;
        operation = true; SetButtons(false, active, false);
        try { await Request(path, payload); }
        catch (Exception error) { MessageBox.Show(this, error.Message, "需要处理", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        finally { operation = false; }
        await RefreshState();
    }
    void SetButtons(bool idle, bool running, bool canReview) {
        idle = idle && !generatingResults;
        start.Enabled = ready && idle && (dataset.SelectedIndex < 3 || (!String.IsNullOrEmpty(excelPath) && !String.IsNullOrEmpty(excelHash)));
        start.BackColor = resumable ? Color.White : Color.FromArgb(39, 96, 205); start.ForeColor = resumable ? Color.FromArgb(38, 54, 76) : Color.White;
        check.Enabled = launch.Enabled = exportCurrent.Enabled = previewDataset.Enabled = ready && idle;
        executable.Enabled = port.Enabled = dataset.Enabled = ready && idle;
        clean.Enabled = ready && idle && (dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4);
        runControl.Text = running ? (pauseRequested ? "正在暂停…" : "暂停") : canHandleManual ? "处理人工步骤" : "继续本轮";
        runControl.Visible = running || resumable || canHandleManual;
        runControl.Enabled = ready && !operation && ((running && !pauseRequested) || (idle && (canHandleManual || resumable)));
        review.Visible = canReview && !running; review.Enabled = ready && idle && canReview;
        generateExcel.Enabled = ready && !operation && !generatingResults && canGenerateResults;
        openResult.Enabled = ready && !operation && BoolOf(ObjectOf(ObjectOf(view, "artifacts"), "result"), "available");
        openBackups.Enabled = ready && !operation && BackupFolders().Count > 0;
        openFolder.Enabled = ready && !operation && CurrentRun() != null && Directory.Exists(folder);
    }
    async Task RefreshState() {
        if (!ready || polling || closing) return;
        polling = true;
        try { ApplyView(await Request("/status", null)); }
        catch (Exception error) { connection.Text = "服务未响应"; detail.Text = error.Message; }
        finally { polling = false; }
    }
    void ApplyView(Dictionary<string, object> snapshot) {
        view = snapshot;
        var connected = ObjectOf(view, "connection"); var run = CurrentRun(); var settings = ObjectOf(view, "settings");
        active = BoolOf(view, "active"); resumable = BoolOf(run, "resumable"); pauseRequested = BoolOf(run, "pauseRequested"); folder = TextOf(view, "directory");
        connection.Text = BoolOf(connected, "ok") ? "已连接" : "未连接";
        connection.ForeColor = BoolOf(connected, "ok") ? Color.FromArgb(27, 123, 84) : Color.FromArgb(126, 98, 57);
        if (BoolOf(connected, "ok")) account.Text = TextOf(connected, "account"); else if (run != null) account.Text = TextOf(run, "account");
        // Load saved settings once; polling must not replace an unsaved local path with stale settings.
        if (!executableInitialized && settings != null) { executable.Text = TextOf(settings, "executable"); executableInitialized = true; }
        canGenerateResults = BoolOf(ObjectOf(view, "resultGeneration"), "available") && !BoolOf(view, "busy");
        canHandleManual = BoolOf(run, "manualAvailable");
        if (run != null && !loadedRun) {
            if (!selectionChosen) {
                dataset.SelectedIndex = TextOf(run, "datasetId") == "excel" ? (TextOf(run, "purpose") == "technical_regression" ? 3 : 4) : TextOf(run, "datasetId") == "smoke" ? 1 : TextOf(run, "purpose") == "technical_regression" ? 2 : 0;
                if (TextOf(run, "datasetId") == "excel") { excelPath = TextOf(run, "inputPath"); excelHash = TextOf(run, "inputHash"); excelFile.Text = excelPath; }
            }
            loadedRun = true;
        }
        UpdateSelectionLabels();
        int total = Math.Max(1, IntOf(run, "total")), completed = IntOf(run, "completed");
        int autoDone = IntOf(run, "automaticCompleted"), autoTotal = IntOf(run, "automaticTotal"), manualDone = IntOf(run, "manualCompleted"), manualTotal = IntOf(run, "manualTotal");
        progress.SetProgress(completed, total);
        headline.Text = run == null ? "准备就绪" : TextOf(run, "activity");
        if (active && pauseRequested) headline.Text = "正在暂停，当前操作结束后保存进度…";
        else if (!active && canHandleManual) headline.Text = autoDone >= autoTotal ? "自动部分已完成，等待人工步骤" : "已到人工步骤，后续仍有自动消息";
        else if (!active && resumable && (TextOf(run, "status") == "paused" || TextOf(run, "status") == "stopped")) headline.Text = "已暂停：可以继续本轮，或选表后新建一轮";
        step.Text = run == null ? "选表、校验并检查连接后开始。" : "步骤 " + TextOf(run, "step") + " · " + TextOf(run, "target") + "    自动 " + autoDone + "/" + autoTotal + "；人工 " + manualDone + "/" + manualTotal + "（跳过 " + IntOf(run, "manualSkipped") + "）    总进度 " + completed + "/" + total;
        string wait = Value(run, "waitSeconds") == null ? "" : "测评间隔剩余 " + IntOf(run, "waitSeconds") + " 秒。 ";
        var observation = ObjectOf(run, "observation");
        if (active && Value(run, "stageElapsedSeconds") != null && TextOf(observation, "stage") != "gap") {
            wait = "当前阶段已持续 " + IntOf(run, "stageElapsedSeconds") + " 秒";
            if (Value(run, "stageRemainingSeconds") != null) wait += "，本阶段剩余上限 " + IntOf(run, "stageRemainingSeconds") + " 秒";
            wait += "。 ";
        }
        string message = TextOf(run, "lastError");
        if (String.IsNullOrEmpty(message)) {
            if (run == null) message = "先选择流程并检查豆包连接；正式测评需核验账号初始状态。";
            else if (active) message = BoolOf(run, "confirmedSent") ? "当前消息已确认发送，正在等待回复或恢复读取，不重复发送。" : "页面异常会先尝试恢复；请勿向本轮自动会话手动追加消息。";
            else if (canHandleManual) message = "点击“处理人工步骤”查看原文与约束并录入首次完整回复；后续自动步骤需回到原自动账号。";
            else if (resumable) message = "“继续本轮”使用原输入快照，等待沿用原截止时间；更换待运行文件只影响新一轮。";
            else message = "本轮执行已结束，可打开已有结果、会话备份，或使用待运行项开始新一轮。";
        }
        if (pauseRequested && active) message = "已提交暂停请求；状态显示“已暂停”后才可选取/校验新文件。已发到豆包的消息不会撤回。";
        var t17 = ObjectOf(run, "t17");
        if (TextOf(run, "status") == "awaiting_manual" && t17 != null) message = "T17人工复测窗口：" + TimeOf(Value(t17, "earliestAt")) + " 至 " + TimeOf(Value(t17, "latestAt")) + "；本版旧B入口仍由人工处理。";
        if (TextOf(run, "status") == "check_failed") message = "连通性消息已执行，但部分回复标记不匹配，请在豆包核对；不会自动重发。";
        if (TextOf(run, "purpose") == "technical_regression") message += "\n本轮只验证自动化执行，不用于记忆能力评分。";
        var resultState = ObjectOf(ObjectOf(view, "resultGeneration"), "automatic");
        string resultStatus = TextOf(resultState, "status");
        if (resultStatus == "failed" || resultStatus == "interrupted") message += "\n结果表问题：" + TextOf(resultState, "error");
        else if (!String.IsNullOrEmpty(TextOf(resultState, "warning"))) message += "\n" + TextOf(resultState, "warning");
        var result = ObjectOf(ObjectOf(view, "artifacts"), "result");
        if (TextOf(result, "copyStatus") == "failed") message += "\n原Excel目录副本未保存，可用生成按钮补存；本轮已有结果仍可打开。";
        detail.Text = wait + message + (IntOf(run, "deviations") > 0 ? "\n执行偏差 " + IntOf(run, "deviations") + " 项，详见运行记录。" : "");
        if (result == null) note.Text = resultStatus == "running" ? "正在生成结果…" : "本轮尚未生成结果；有回复记录后可生成当前进度结果。";
        else if (!BoolOf(result, "available")) note.Text = "本轮最新结果文件已移动或删除；查看不会自动重建，请核对运行记录。";
        else note.Text = "本轮最新：" + TextOf(result, "label") + (Value(result, "processedRows") == null ? "" : "（" + IntOf(result, "processedRows") + "/" + IntOf(result, "totalRows") + "行）")
            + (BoolOf(result, "stale") ? "；还有新记录，可生成当前进度结果" : "")
            + (TextOf(result, "copyStatus") == "failed" ? "；双份保存尚未齐全" : "");
        hints.SetToolTip(note, TextOf(result, "file"));
        var builder = new StringBuilder(); var entries = Value(view, "logs") as IEnumerable;
        if (entries != null) foreach (object item in entries) { var entry = item as Dictionary<string, object>; builder.AppendLine(TimeOf(Value(entry, "at")) + "  " + TextOf(entry, "message")); }
        string updated = builder.ToString();
        if (updated != logText) { logText = updated; logs.Text = updated; logs.SelectionStart = logs.TextLength; logs.ScrollToCaret(); }
        SetButtons(!active && !operation && !BoolOf(view, "busy"), active, BoolOf(run, "canReviewRetry"));
    }
    async void OnClosing(object sender, FormClosingEventArgs e) {
        if (closed) return;
        e.Cancel = true;
        if (closing) return;
        if (active && MessageBox.Show(this, "关闭窗口将停止执行并保存进度，之后可重新打开继续。确定关闭？", "退出执行器", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        closing = true; timer.Stop();
        try { if (ready) await Request("/shutdown", new Dictionary<string, object>()); }
        catch { /* Write-ahead state is retained even if the service disappeared. */ }
        finally {
            if (backend != null) { try { if (!backend.HasExited && !backend.WaitForExit(3000)) backend.Kill(); } catch { } }
            closed = true; Close();
        }
    }
    [STAThread]
    static void Main() {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new RunnerWindow());
    }
}
