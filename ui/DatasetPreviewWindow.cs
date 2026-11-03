using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class DatasetPreviewWindow : Form {
    readonly Func<string, Task<Dictionary<string, object>>> reader;
    readonly TextBox file = new TextBox(), fullMessage = new TextBox();
    readonly Button choose = new Button(), validate = new Button();
    readonly Label summary = new Label(), selection = new Label();
    readonly DataGridView flow = Grid(), issues = Grid();
    readonly TabControl tabs = new TabControl();
    bool checking;
    readonly Button use = new Button();
    public Dictionary<string, object> ValidatedReport { get; private set; }
    public bool UseForExecution { get; private set; }
    public string SelectedFilePath { get { return file.Text; } }
    static object Value(Dictionary<string, object> obj, string key) { object value; return obj != null && obj.TryGetValue(key, out value) ? value : null; }
    static string TextOf(Dictionary<string, object> obj, string key) { return Convert.ToString(Value(obj, key)); }
    static int IntOf(Dictionary<string, object> obj, string key) { return Convert.ToInt32(Value(obj, key) ?? 0); }
    static Dictionary<string, object> ObjectOf(Dictionary<string, object> obj, string key) { return Value(obj, key) as Dictionary<string, object>; }
    static DataGridView Grid() {
        return new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false,
            AllowUserToDeleteRows = false, AllowUserToOrderColumns = false, AutoGenerateColumns = false,
            RowHeadersVisible = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false,
            BackgroundColor = Color.White, BorderStyle = BorderStyle.FixedSingle, ColumnHeadersHeight = 34,
            RowTemplate = { Height = 28 }, ClipboardCopyMode = DataGridViewClipboardCopyMode.EnableAlwaysIncludeHeaderText };
    }
    static void AddColumn(DataGridView grid, string key, string label, int width) {
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = key, HeaderText = label, Width = width,
            SortMode = DataGridViewColumnSortMode.NotSortable });
    }
    public DatasetPreviewWindow(string initialPath, Func<string, Task<Dictionary<string, object>>> read) {
        reader = read; Text = "测评集校验与预览"; ClientSize = new Size(1180, 800); MinimumSize = new Size(1000, 700);
        StartPosition = FormStartPosition.CenterParent; Font = new Font("Microsoft YaHei UI", 9F); AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(244, 247, 251);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 1, RowCount = 7 };
        foreach (int height in new int[] { 48, 34, 54 }) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 156)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        Controls.Add(layout);
        var pathRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 1 };
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80)); pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 112)); pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 124));
        pathRow.Controls.Add(new Label { Text = "测评集文件", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
        file.ReadOnly = true; file.Dock = DockStyle.Fill; file.Text = initialPath ?? ""; file.AccessibleName = "只读测评集文件路径"; pathRow.Controls.Add(file, 1, 0);
        choose.Text = "选择 Excel"; choose.Dock = DockStyle.Fill; choose.AccessibleName = "选择Excel测评集"; pathRow.Controls.Add(choose, 2, 0);
        validate.Text = "校验并预览"; validate.Dock = DockStyle.Fill; validate.AccessibleName = "校验并预览"; pathRow.Controls.Add(validate, 3, 0);
        layout.Controls.Add(pathRow, 0, 0);
        layout.Controls.Add(new Label { Dock = DockStyle.Fill, Text = "先校验，再选择“用于本轮执行”；实际发送仍需回主界面点击开始。原Excel保留。", TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.FromArgb(95, 109, 131) }, 0, 1);
        summary.Dock = DockStyle.Fill; summary.Text = "选择双表格式的测评集，再点击“校验并预览”。"; summary.TextAlign = ContentAlignment.MiddleLeft;
        summary.Font = new Font(Font.FontFamily, 10F, FontStyle.Bold); layout.Controls.Add(summary, 0, 2);
        var flowPage = new TabPage("流程预览"); var issuePage = new TabPage("校验信息");
        tabs.Dock = DockStyle.Fill; tabs.TabPages.Add(flowPage); tabs.TabPages.Add(issuePage); flowPage.Controls.Add(flow); issuePage.Controls.Add(issues);
        AddColumn(flow, "order", "顺序", 58); AddColumn(flow, "step", "步骤ID", 86); AddColumn(flow, "identity", "身份ID", 66);
        AddColumn(flow, "conversation", "会话ID", 100); AddColumn(flow, "navigation", "计划会话操作", 130);
        AddColumn(flow, "mode", "执行方式", 84); AddColumn(flow, "type", "消息类型", 104); AddColumn(flow, "question", "问题ID", 136);
        AddColumn(flow, "wait", "回复后等待秒", 110); AddColumn(flow, "content", "发送内容（选中看全文）", 320); AddColumn(flow, "source", "Excel行", 76);
        flow.Columns[0].Frozen = true; flow.Columns[1].Frozen = true;
        AddColumn(issues, "severity", "级别", 65); AddColumn(issues, "sheet", "工作表", 130); AddColumn(issues, "row", "行", 60);
        AddColumn(issues, "column", "列", 60); AddColumn(issues, "message", "具体问题或人工提示", 680);
        issues.Columns[4].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill; issues.Columns[4].MinimumWidth = 400;
        issues.DefaultCellStyle.WrapMode = DataGridViewTriState.True; issues.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells;
        layout.Controls.Add(tabs, 0, 3);
        selection.Text = "完整发送原文（只读）"; selection.Dock = DockStyle.Fill; selection.TextAlign = ContentAlignment.MiddleLeft; selection.AutoEllipsis = true;
        layout.Controls.Add(selection, 0, 4);
        fullMessage.ReadOnly = true; fullMessage.Multiline = true; fullMessage.ScrollBars = ScrollBars.Vertical; fullMessage.Dock = DockStyle.Fill;
        fullMessage.BackColor = Color.White; fullMessage.AccessibleName = "完整发送原文"; layout.Controls.Add(fullMessage, 0, 5);
        var footer = new Panel { Dock = DockStyle.Fill };
        footer.Controls.Add(new Label { Text = "按步骤ID执行；MANUAL由人工处理；原文及等待秒数来自所选文件。", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft });
        var close = new Button { Text = "关闭预览", Dock = DockStyle.Right, Width = 112 }; close.Click += delegate { Close(); }; footer.Controls.Add(close);
        use.Text = "用于本轮执行"; use.Dock = DockStyle.Right; use.Width = 136; use.Enabled = false;
        use.Click += delegate { if (ValidatedReport != null) { UseForExecution = true; Close(); } }; footer.Controls.Add(use); layout.Controls.Add(footer, 0, 6);
        choose.Click += delegate {
            using (var dialog = new OpenFileDialog { Filter = "Excel工作簿 (*.xlsx)|*.xlsx", Multiselect = false, CheckFileExists = true, Title = "选择双表格式测评集" }) {
                if (File.Exists(file.Text)) { dialog.InitialDirectory = Path.GetDirectoryName(file.Text); dialog.FileName = Path.GetFileName(file.Text); }
                if (dialog.ShowDialog(this) == DialogResult.OK) { file.Text = dialog.FileName; ClearReport(); summary.ForeColor = Color.FromArgb(38, 54, 76); summary.Text = "已选择文件，请点击“校验并预览”。"; }
            }
        };
        validate.Click += async delegate { await ValidateFile(); };
        flow.SelectionChanged += delegate { ShowMessage(); };
    }
    void ClearReport() { ValidatedReport = null; use.Enabled = false; UseForExecution = false; flow.Rows.Clear(); issues.Rows.Clear(); fullMessage.Clear(); selection.Text = "完整发送原文（只读）"; }
    async Task ValidateFile() {
        if (checking) return;
        if (String.IsNullOrEmpty(file.Text)) { summary.Text = "请先选择.xlsx文件。"; return; }
        checking = true; choose.Enabled = validate.Enabled = false; ClearReport(); summary.ForeColor = Color.FromArgb(38, 54, 76); summary.Text = "正在读取并校验测评集…";
        try { var report = await reader(file.Text); if (!IsDisposed) ApplyReport(report); }
        catch (Exception error) { if (!IsDisposed) { ClearReport(); summary.Text = "读取未完成：" + error.Message; summary.ForeColor = Color.Firebrick; } }
        finally { checking = false; if (!IsDisposed) choose.Enabled = validate.Enabled = true; }
    }
    void ApplyReport(Dictionary<string, object> report) {
        ClearReport(); var counts = ObjectOf(report, "summary"); bool valid = Value(report, "valid") is bool && (bool)Value(report, "valid");
        bool supported = !(Value(report, "executionSupported") is bool) || (bool)Value(report, "executionSupported");
        ValidatedReport = valid && supported ? report : null; use.Enabled = valid && supported;
        summary.ForeColor = valid ? Color.FromArgb(27, 123, 84) : Color.Firebrick;
        summary.Text = (valid ? "校验通过（选择后可执行）" : "校验未通过") + "：" + IntOf(counts, "total") + "条消息，" + IntOf(counts, "automatic") + "自动、" + IntOf(counts, "manual") + "人工；"
            + IntOf(counts, "questions") + "个问题，" + IntOf(counts, "conversations") + "个会话（自动涉及" + IntOf(counts, "automaticConversations") + "个）。\n"
            + IntOf(counts, "errors") + "个错误，" + IntOf(counts, "warnings") + "条提示。人工节点提示不代表校验失败。";
        if (!supported) { summary.Text = "格式校验完成，但当前执行方式不支持：" + TextOf(report, "executionError"); summary.ForeColor = Color.Firebrick; }
        var rows = Value(report, "steps") as IEnumerable;
        if (rows != null) foreach (object item in rows) {
            var row = item as Dictionary<string, object>; if (row == null) continue;
            string content = TextOf(row, "content"), shortText = content.Replace("\r", " ").Replace("\n", " ");
            if (shortText.Length > 120) shortText = shortText.Substring(0, 120) + "…";
            int index = flow.Rows.Add(IntOf(row, "order"), TextOf(row, "stepId"), TextOf(row, "identityId"), TextOf(row, "conversationId"),
                TextOf(row, "navigationLabel"), TextOf(row, "mode"), TextOf(row, "messageType"), TextOf(row, "questionId"), Value(row, "waitSeconds"), shortText, IntOf(row, "sourceRow"));
            flow.Rows[index].Tag = row;
            if (TextOf(row, "mode") == "MANUAL") flow.Rows[index].DefaultCellStyle.BackColor = Color.FromArgb(255, 245, 215);
        }
        var entries = Value(report, "issues") as IEnumerable;
        if (entries != null) foreach (object item in entries) {
            var entry = item as Dictionary<string, object>; if (entry == null) continue;
            bool error = TextOf(entry, "severity") == "error";
            int index = issues.Rows.Add(error ? "错误" : "提示", TextOf(entry, "sheet"), Value(entry, "row"), TextOf(entry, "column"), TextOf(entry, "message"));
            issues.Rows[index].DefaultCellStyle.ForeColor = error ? Color.Firebrick : Color.FromArgb(126, 98, 57);
        }
        tabs.SelectedIndex = valid ? 0 : 1;
        if (flow.Rows.Count > 0) { flow.ClearSelection(); flow.Rows[0].Selected = true; flow.CurrentCell = flow.Rows[0].Cells[0]; }
        ShowMessage();
    }
    void ShowMessage() {
        if (flow.SelectedRows.Count == 0) { fullMessage.Clear(); return; }
        var row = flow.SelectedRows[0].Tag as Dictionary<string, object>; if (row == null) { fullMessage.Clear(); return; }
        // Win32 multiline edit controls display CRLF. The report's raw content
        // remains untouched; normalize line endings only in the read-only view.
        fullMessage.Text = TextOf(row, "content").Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "\r\n");
        selection.Text = TextOf(row, "stepId") + " · " + TextOf(row, "conversationId") + " · " + TextOf(row, "mode") + " · Excel第" + IntOf(row, "sourceRow") + "行 · 完整发送原文（只读）";
        if (!String.IsNullOrEmpty(TextOf(row, "anchorQuestionId"))) selection.Text += " · 计时锚点 " + TextOf(row, "anchorQuestionId") + "，距锚点" + TextOf(row, "minAfterAnchorSeconds") + "—" + TextOf(row, "maxAfterAnchorSeconds") + "秒";
    }
}
