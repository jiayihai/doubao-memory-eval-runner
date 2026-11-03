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
    bool ready, polling, operation, active, resumable, closing, closed, loadedRun, generatingResults, canGenerateResults, canHandleManual;
    readonly Timer timer = new Timer { Interval = 750 };
    readonly TextBox executable = new TextBox(), account = new TextBox(), logs = new TextBox(), excelFile = new TextBox();
    readonly Label timingHint = new Label();
    readonly NumericUpDown port = new NumericUpDown { Minimum = 1024, Maximum = 65535, Value = 9223 };
    readonly ComboBox dataset = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
    readonly CheckBox clean = new CheckBox { Text = "我已核验正式测评账号的独立初始状态（工具不清理记忆）", AutoSize = true };
    readonly Label connection = new Label(), headline = new Label(), step = new Label(), detail = new Label(), note = new Label();
    readonly CompletionBar progress = new CompletionBar();
    readonly Button launch = new Button(), check = new Button(), start = new Button(), pause = new Button(), resume = new Button(), stop = new Button(), review = new Button(), openFolder = new Button(), exportCurrent = new Button(), generateExcel = new Button(), previewDataset = new Button(), manualSteps = new Button();
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
        Text = "豆包测评执行器 V1.6.0"; ClientSize = new Size(980, 800); MinimumSize = new Size(930, 780);
        json.MaxJsonLength = 20 * 1024 * 1024;
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(244, 247, 251);
        Font = new Font("Microsoft YaHei UI", 9F); AutoScaleMode = AutoScaleMode.Dpi;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24, 18, 24, 18), ColumnCount = 1, RowCount = 8 };
        foreach (int size in new int[] { 66, 182, 48, 40, 90, 114 }) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, size));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
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
        config.Controls.Add(new Label { Text = "测评集文件", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 3);
        excelFile.ReadOnly = true; excelFile.Dock = DockStyle.Fill; excelFile.Text = "尚未选择；内置流程不需要"; config.Controls.Add(excelFile, 1, 3); config.SetColumnSpan(excelFile, 3);
        StyleButton(previewDataset, "选取/校验", false); previewDataset.AccessibleName = "测评集校验预览"; previewDataset.Dock = DockStyle.Fill; config.Controls.Add(previewDataset, 4, 3);
        layout.Controls.Add(config, 0, 1);
        var cleanPanel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 10, 0, 0) }; cleanPanel.Controls.Add(clean); layout.Controls.Add(cleanPanel, 0, 2);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        StyleButton(start, "开始新一轮", true); StyleButton(pause, "暂停", false); StyleButton(resume, "继续", true); StyleButton(stop, "停止", false);
        StyleButton(review, "核对后重试", false); review.Width = 126;
        start.AccessibleName = "开始新一轮"; pause.AccessibleName = "暂停"; resume.AccessibleName = "继续"; stop.AccessibleName = "停止"; review.AccessibleName = "核对后重试";
        StyleButton(exportCurrent, "导出已加载对话", false); exportCurrent.Width = 154; exportCurrent.AccessibleName = "导出已加载对话";
        foreach (var b in new Button[] { start, pause, resume, stop, review, exportCurrent }) actions.Controls.Add(b);
        layout.Controls.Add(actions, 0, 3);
        var statusPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 8, 0, 10) };
        headline.Text = "正在准备运行环境…"; headline.Font = new Font(Font.FontFamily, 12F, FontStyle.Bold); headline.AutoSize = false; headline.Size = new Size(900, 28); headline.Location = new Point(0, 8);
        step.Text = "尚未开始"; step.AutoSize = false; step.Size = new Size(900, 23); step.Location = new Point(0, 38);
        progress.Height = 12; progress.Dock = DockStyle.Bottom; progress.AccessibleName = "已确认完成消息进度";
        statusPanel.Controls.AddRange(new Control[] { headline, step, progress }); layout.Controls.Add(statusPanel, 0, 4);
        detail.Dock = DockStyle.Fill; detail.ForeColor = Color.FromArgb(95, 109, 131); detail.Text = "首次运行请先检查连接。正式流程不会自动开始。";
        detail.Padding = new Padding(0, 8, 0, 0); layout.Controls.Add(detail, 0, 5);
        logs.Multiline = true; logs.ReadOnly = true; logs.ScrollBars = ScrollBars.Vertical; logs.Dock = DockStyle.Fill;
        logs.Font = new Font("Microsoft YaHei UI", 9F); logs.BackColor = Color.White; logs.BorderStyle = BorderStyle.FixedSingle; logs.AccessibleName = "运行日志";
        layout.Controls.Add(logs, 0, 6);
        var footer = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0, 6, 0, 0) };
        note.Text = "回复与结果保存在本轮记录中；T17人工执行。"; note.Dock = DockStyle.Fill; note.TextAlign = ContentAlignment.MiddleLeft; note.ForeColor = detail.ForeColor;
        StyleButton(openFolder, "打开运行记录", false); openFolder.Width = 126;
        StyleButton(generateExcel, "生成结果 Excel", false); generateExcel.Width = 146; generateExcel.AccessibleName = "生成结果 Excel";
        StyleButton(manualSteps, "人工步骤", false); manualSteps.Width = 136;
        var resultActions = new FlowLayoutPanel { Dock = DockStyle.Right, Width = 438, WrapContents = false };
        resultActions.Controls.Add(manualSteps); resultActions.Controls.Add(generateExcel); resultActions.Controls.Add(openFolder);
        footer.Controls.Add(note); footer.Controls.Add(resultActions); layout.Controls.Add(footer, 0, 7);
        dataset.SelectedIndexChanged += delegate { clean.Enabled = dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4;
            timingHint.Text = dataset.SelectedIndex >= 3 ? "确认回答结束 → 按Excel每行等待秒数 → 下一步骤 · MANUAL由人工处理" : "确认回答结束 → 测评间隔 30 秒 → 准备下一条 · 页面异常自动恢复"; };
        check.Click += async delegate { await Command("/check", Options()); };
        launch.Click += async delegate { await Command("/launch", Options()); };
        start.Click += async delegate {
            if ((dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4) && !clean.Checked) { MessageBox.Show(this, "请先核验正式测评账号初始状态，并勾选确认。", "开始前检查"); return; }
            if (dataset.SelectedIndex >= 3 && String.IsNullOrEmpty(excelPath)) { MessageBox.Show(this, "请先选取、校验Excel，并点击“用于本轮执行”。", "尚未选择测评集"); return; }
            if (resumable && MessageBox.Show(this, "有未完成任务。新建一轮将不再默认恢复旧任务，旧记录仍保留。确定新建？", "新建运行", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            Dictionary<string, object> opts = Options(); opts["datasetId"] = dataset.SelectedIndex >= 3 ? "excel" : dataset.SelectedIndex == 1 ? "smoke" : "doubao-b";
            opts["purpose"] = dataset.SelectedIndex == 2 || dataset.SelectedIndex == 3 ? "technical_regression" : "formal_evaluation";
            opts["acknowledgeExistingMemory"] = dataset.SelectedIndex == 2 || dataset.SelectedIndex == 3;
            opts["cleanDeclared"] = (dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4) && clean.Checked; opts["abandon"] = resumable;
            opts["excelPath"] = excelPath; opts["excelHash"] = excelHash;
            await Command("/start", opts);
        };
        pause.Click += async delegate { await Command("/pause", new Dictionary<string, object>()); };
        resume.Click += async delegate { await Command("/resume", new Dictionary<string, object>()); };
        stop.Click += async delegate { await Command("/stop", new Dictionary<string, object>()); };
        review.Click += async delegate {
            if (MessageBox.Show(this, "请先在豆包中核对：上一条消息确实没有发送。此操作允许重新尝试该条，并记录人工处理。确定未发送？", "核对发送状态", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes) await Command("/retry-not-sent", new Dictionary<string, object>());
        };
        openFolder.Click += delegate { if (!String.IsNullOrEmpty(folder) && Directory.Exists(folder)) Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true }); };
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
                string resultFolder = TextOf(result, "directory");
                string copyInfo = String.IsNullOrEmpty(TextOf(result, "sourceFile")) ? "" : "\n原Excel目录副本：\n" + TextOf(result, "sourceFile") + (TextOf(result, "copyStatus") == "failed" ? "\n副本未完成：" + TextOf(result, "copyError") + "；再次点击结果按钮补存。" : "\n两份Excel内容一致。");
                MessageBox.Show(this, "已生成结果，原模板未改动。\n\n已保存回复 " + IntOf(result, "savedReplies") + " / " + IntOf(result, "totalRows") + " 条；问题回答 " + IntOf(result, "questionsFilled") + " / " + IntOf(result, "questionsTotal") + " 条；跳过 " + IntOf(result, "skippedRows") + " 条。\n已完成不代表评分通过；长回答可通过编辑栏查看。\n\n运行记录中的结果：\n" + TextOf(result, "file") + copyInfo, "结果表已生成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                if (Directory.Exists(resultFolder)) Process.Start(new ProcessStartInfo(resultFolder) { UseShellExecute = true });
            } catch (Exception error) { MessageBox.Show(this, error.Message, "结果表未生成", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            finally { generatingResults = false; generateExcel.Text = "生成结果 Excel"; }
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
                    if (preview.UseForExecution && preview.ValidatedReport != null) { var source = ObjectOf(preview.ValidatedReport, "file"); excelPath = TextOf(source, "path"); excelHash = TextOf(source, "sha256"); excelFile.Text = excelPath; dataset.SelectedIndex = 3; }
                }
            } finally { operation = false; }
            await RefreshState();
        };
        manualSteps.Click += async delegate {
            if (!ready || operation || active || !canHandleManual) return;
            operation = true; SetButtons(false, active, false);
            try { using (var window = new ManualStepWindow(async () => ObjectOf(await Request("/manual-details", new Dictionary<string, object>()), "result"),
                async input => ObjectOf(await Request("/manual-submit", input), "result"))) window.ShowDialog(this); }
            finally { operation = false; }
            await RefreshState();
        };
        timer.Tick += async delegate { await RefreshState(); };
        Shown += async delegate { await Boot(); };
        FormClosing += OnClosing;
        SetButtons(false, false, false);
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
        start.Enabled = ready && idle; check.Enabled = launch.Enabled = ready && idle;
        exportCurrent.Enabled = ready && idle;
        previewDataset.Enabled = ready && idle;
        manualSteps.Enabled = ready && idle && canHandleManual;
        generateExcel.Enabled = ready && !operation && !generatingResults && canGenerateResults;
        executable.Enabled = port.Enabled = dataset.Enabled = ready && idle;
        clean.Enabled = ready && idle && (dataset.SelectedIndex == 0 || dataset.SelectedIndex == 4);
        pause.Enabled = stop.Enabled = ready && running && !operation;
        resume.Enabled = ready && idle && resumable; review.Enabled = ready && idle && canReview;
    }
    async Task RefreshState() {
        if (!ready || polling || closing) return;
        polling = true;
        try {
            view = await Request("/status", null);
            var connected = ObjectOf(view, "connection"); var run = ObjectOf(view, "run"); var settings = ObjectOf(view, "settings");
            connection.Text = BoolOf(connected, "ok") ? "已连接" : "未连接";
            connection.ForeColor = BoolOf(connected, "ok") ? Color.FromArgb(27, 123, 84) : Color.FromArgb(126, 98, 57);
            if (BoolOf(connected, "ok")) account.Text = TextOf(connected, "account");
            else if (run != null) account.Text = TextOf(run, "account");
            if (!active && !executable.Focused && settings != null && !operation) executable.Text = TextOf(settings, "executable");
            active = BoolOf(view, "active"); resumable = BoolOf(run, "resumable"); folder = TextOf(view, "directory");
            canGenerateResults = BoolOf(ObjectOf(view, "resultGeneration"), "available") && !BoolOf(view, "busy");
            canHandleManual = BoolOf(run, "manualAvailable");
            if (run != null && !loadedRun) { dataset.SelectedIndex = TextOf(run, "datasetId") == "excel" ? (TextOf(run, "purpose") == "technical_regression" ? 3 : 4) : TextOf(run, "datasetId") == "smoke" ? 1 : TextOf(run, "purpose") == "technical_regression" ? 2 : 0;
                if (TextOf(run, "datasetId") == "excel") { excelPath = TextOf(run, "inputPath"); excelHash = TextOf(run, "inputHash"); excelFile.Text = excelPath; } loadedRun = true; }
            headline.Text = run == null ? "准备就绪" : TextOf(run, "activity");
            int total = Math.Max(1, IntOf(run, "total")), completed = IntOf(run, "completed");
            progress.SetProgress(completed, total);
            int percent = (int)Math.Floor(100.0 * completed / total);
            step.Text = run == null ? "选择流程后点击开始；建议先运行连通性测试。" : (TextOf(run, "datasetId") == "smoke" ? "连通性测试 · " : TextOf(run, "purpose") == "technical_regression" ? "长流程技术回归 · " : "旧豆包 B · ") + TextOf(run, "step") + " · " + TextOf(run, "target") + "    已确认完成 " + completed + " / " + total + " 条（" + percent + "%）";
            if (TextOf(run, "datasetId") == "excel") step.Text = TextOf(run, "step") + " · 已处理 " + completed + " / " + total + " 步（" + percent + "%），自动回复 " + IntOf(run, "automaticCompleted") + "，人工 " + IntOf(run, "manualCompleted") + "（含跳过 " + IntOf(run, "manualSkipped") + "）。";
            string wait = Value(run, "waitSeconds") == null ? "" : "测评间隔剩余 " + IntOf(run, "waitSeconds") + " 秒。 ";
            var observation = ObjectOf(run, "observation");
            if (active && Value(run, "stageElapsedSeconds") != null && TextOf(observation, "stage") != "gap") {
                wait = "当前阶段已持续 " + IntOf(run, "stageElapsedSeconds") + " 秒";
                if (Value(run, "stageRemainingSeconds") != null) wait += "，本阶段剩余上限 " + IntOf(run, "stageRemainingSeconds") + " 秒";
                wait += "。 ";
            }
            string message = TextOf(run, "lastError");
            if (String.IsNullOrEmpty(message)) message = run == null ? "“启动豆包”会尝试建立调试连接；若豆包已运行但无法连接，请先自行完全退出豆包。" : BoolOf(run, "confirmedSent") ? "当前消息已确认发送；正在等待回答或恢复读取，不会自动重复发送。" : "短暂加载与连接异常会先自动恢复。请勿向本轮会话手动追加消息。";
            if (canHandleManual) message = "已到人工节点。点击“人工步骤”查看原文与约束，操作后录入首次完整回复；后续自动步骤需回到原自动账号再点击继续。";
            if (TextOf(run, "datasetId") == "excel") message = "本轮输入快照：" + TextOf(run, "inputName") + "\n" + message;
            var t17 = ObjectOf(run, "t17");
            if (TextOf(run, "status") == "awaiting_manual" && t17 != null) message = "T17 人工复测窗口：" + TimeOf(Value(t17, "earliestAt")) + " 至 " + TimeOf(Value(t17, "latestAt")) + "。时间以观察到回答结束为基准。";
            if (TextOf(run, "status") == "completed" && TextOf(run, "datasetId") == "smoke") message = "测试通过：4条消息及回复均已确认。主会话应有3条用户消息，新会话应有1条；最后回复 CDP_V1_RETURN_OK。";
            if (TextOf(run, "status") == "check_failed") message = "4条消息已执行结束，但部分回复标记不匹配，请在豆包中核对。不会自动重发。";
            if (TextOf(run, "purpose") == "technical_regression" && String.IsNullOrEmpty(TextOf(run, "lastError"))) message += "\n本轮沿用当前账号状态，只验证自动化执行，不用于记忆能力评分。";
            if (TextOf(run, "datasetId") == "excel") message += "\n自动回复已保存 " + IntOf(run, "capturedReplies") + " 条，人工已处理 " + IntOf(run, "manualCompleted") + " 条（含跳过 " + IntOf(run, "manualSkipped") + "）；备份按身份保存。";
            else if (BoolOf(run, "replyCaptureEnabled")) message += "\n回复已保存 " + IntOf(run, "capturedReplies") + " / " + completed + " 条，会话备份 " + IntOf(run, "backupConversations") + " 个；见运行记录中的“会话备份”。";
            else if (run != null) message += "\n旧轮未开启自动保存；验证回复备份请开始新版新一轮。";
            var resultState = ObjectOf(ObjectOf(view, "resultGeneration"), "automatic");
            string resultStatus = TextOf(resultState, "status");
            if (resultStatus == "failed" || resultStatus == "interrupted") message += "\n结果表问题：" + TextOf(resultState, "error");
            else if (!String.IsNullOrEmpty(TextOf(resultState, "warning"))) message += "\n" + TextOf(resultState, "warning");
            var resultPayload = ObjectOf(resultState, "result");
            if (TextOf(resultPayload, "copyStatus") == "failed") message += "\n原Excel目录副本未保存：" + TextOf(resultPayload, "copyError");
            detail.Text = wait + message + (IntOf(run, "deviations") > 0 ? "\n已记录 " + IntOf(run, "deviations") + " 项执行偏差，请查看运行记录。" : "");
            note.Text = BoolOf(run, "namingEnabled")
                ? "命名：成功 " + IntOf(run, "namingDone") + "，待处理 " + IntOf(run, "namingPending") + "，未完成 " + IntOf(run, "namingFailed") + "。T17人工执行。"
                : "回复与结果保存在本轮记录中；T17人工执行。";
            if (TextOf(run, "datasetId") == "excel") note.Text = "Excel按表执行；人工节点和结果可通过右侧按钮处理。";
            if (resultStatus == "succeeded") note.Text = TextOf(run, "datasetId") == "excel" ? "结果见本轮“测评结果”及原Excel目录；人工步骤见对应按钮。" : "结果表已生成，见本轮“测评结果”；T17仍待人工执行。";
            else if (resultStatus == "running") note.Text = "自动部分已完成，正在生成结果表…";
            var builder = new StringBuilder(); var entries = Value(view, "logs") as IEnumerable;
            if (entries != null) foreach (object item in entries) { var entry = item as Dictionary<string, object>; builder.AppendLine(TimeOf(Value(entry, "at")) + "  " + TextOf(entry, "message")); }
            string updated = builder.ToString();
            if (updated != logText) { logText = updated; logs.Text = updated; logs.SelectionStart = logs.TextLength; logs.ScrollToCaret(); }
            SetButtons(!active && !operation && !BoolOf(view, "busy"), active, BoolOf(run, "canReviewRetry"));
        } catch (Exception error) { connection.Text = "服务未响应"; detail.Text = error.Message; }
        finally { polling = false; }
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
