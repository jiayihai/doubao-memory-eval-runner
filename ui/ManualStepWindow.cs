using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class ManualStepWindow : Form {
    readonly Func<Task<Dictionary<string, object>>> loader;
    readonly Func<Dictionary<string, object>, Task<Dictionary<string, object>>> saver;
    readonly Label header = new Label(), clock = new Label();
    readonly TextBox instructions = new TextBox(), account = new TextBox(), answer = new TextBox(), reason = new TextBox();
    readonly CheckBox confirmed = new CheckBox();
    readonly Button save = new Button(), skip = new Button();
    readonly Timer timer = new Timer { Interval = 1000 };
    Dictionary<string, object> details; bool checking;
    static object Value(Dictionary<string, object> o, string k) { object v; return o != null && o.TryGetValue(k, out v) ? v : null; }
    static string TextOf(Dictionary<string, object> o, string k) { return Convert.ToString(Value(o, k)); }
    static bool BoolOf(Dictionary<string, object> o, string k) { return Value(o, k) is bool && (bool)Value(o, k); }
    static Dictionary<string, object> ObjectOf(Dictionary<string, object> o, string k) { return Value(o, k) as Dictionary<string, object>; }
    static double Now() { return (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
    public ManualStepWindow(Func<Task<Dictionary<string, object>>> load, Func<Dictionary<string, object>, Task<Dictionary<string, object>>> submit) {
        loader = load; saver = submit; Text = "人工步骤处理（由你发送，脚本只保存结果）"; ClientSize = new Size(980, 780); MinimumSize = new Size(900, 700);
        Font = new Font("Microsoft YaHei UI", 9F); AutoScaleMode = AutoScaleMode.Dpi; StartPosition = FormStartPosition.CenterParent;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 1, RowCount = 9 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 60)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        Controls.Add(layout); header.Dock = DockStyle.Fill; header.Font = new Font(Font.FontFamily, 11F, FontStyle.Bold); layout.Controls.Add(header, 0, 0);
        instructions.Multiline = true; instructions.ReadOnly = true; instructions.ScrollBars = ScrollBars.Vertical; instructions.Dock = DockStyle.Fill; instructions.BackColor = Color.White; layout.Controls.Add(instructions, 0, 1);
        var accountRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 }; accountRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180)); accountRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        accountRow.Controls.Add(new Label { Text = "实际人工账号标识", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0); account.Dock = DockStyle.Fill; accountRow.Controls.Add(account, 1, 0); layout.Controls.Add(accountRow, 0, 2);
        confirmed.Text = "我已满足本行约束和前置要求，在指定身份按原文完成操作，并粘贴首次完整回复。"; confirmed.Dock = DockStyle.Fill; layout.Controls.Add(confirmed, 0, 3);
        clock.Dock = DockStyle.Fill; clock.ForeColor = Color.FromArgb(126, 98, 57); layout.Controls.Add(clock, 0, 4);
        layout.Controls.Add(new Label { Text = "首次完整回复（人工录入；未由CDP核验消息ID或平台回复时间）", Dock = DockStyle.Fill }, 0, 5);
        answer.Multiline = true; answer.ScrollBars = ScrollBars.Vertical; answer.Dock = DockStyle.Fill; answer.MaxLength = 0; layout.Controls.Add(answer, 0, 6);
        var reasonRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 }; reasonRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180)); reasonRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        reasonRow.Controls.Add(new Label { Text = "跳过原因（跳过时必填）", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0); reason.Dock = DockStyle.Fill; reasonRow.Controls.Add(reason, 1, 0); layout.Controls.Add(reasonRow, 0, 7);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        var close = new Button { Text = "关闭", Width = 90, Height = 34 }; close.Click += delegate { Close(); };
        skip.Text = "记录跳过并继续"; skip.Width = 150; skip.Height = 34; save.Text = "保存本步并查看下一步"; save.Width = 190; save.Height = 34;
        actions.Controls.Add(close); actions.Controls.Add(skip); actions.Controls.Add(save); layout.Controls.Add(actions, 0, 8);
        save.Click += async delegate { await Submit(false); }; skip.Click += async delegate { await Submit(true); };
        confirmed.CheckedChanged += delegate { UpdateReady(); }; answer.TextChanged += delegate { UpdateReady(); };
        timer.Tick += delegate { UpdateReady(); }; FormClosed += delegate { timer.Stop(); timer.Dispose(); };
        Shown += async delegate { try { var d = await loader(); if (!IsDisposed) { Apply(d); timer.Start(); } } catch (Exception e) { if (!IsDisposed) header.Text = e.Message; } };
        save.Enabled = skip.Enabled = false;
    }
    void Apply(Dictionary<string, object> d) {
        details = d; if (d == null) { header.Text = "当前没有待处理人工步骤"; save.Enabled = skip.Enabled = false; return; }
        header.Text = TextOf(d, "stepId") + " · 身份 " + TextOf(d, "identityId") + " · 会话 " + TextOf(d, "conversationId") + " · 剩余人工步骤 " + TextOf(d, "remaining");
        instructions.Text = ("发送原文：\n" + TextOf(d, "content") + "\n\n表中执行约束：\n" + TextOf(d, "constraint")
            + "\n\n账号、发送和前置条件由人工核对；此窗口不会登录账号或替你发送。" ).Replace("\r\n", "\n").Replace("\n", "\r\n");
        account.Text = TextOf(d, "defaultAccount"); answer.Clear(); reason.Clear(); confirmed.Checked = false; UpdateReady();
    }
    void UpdateReady() {
        if (details == null || IsDisposed) return;
        double ready = Convert.ToDouble(Value(details, "readyAt") ?? 0), latest = Convert.ToDouble(Value(details, "latestAt") ?? 0), now = Now();
        string problem = TextOf(details, "preconditionError"); if (latest > 0 && now > latest) problem = "已超过本步时间窗口，请记录前提不足或跳过原因。";
        double remaining = Math.Max(0, Math.Ceiling((ready - now) / 1000));
        clock.Text = problem.Length > 0 ? problem : remaining > 0 ? "距本步允许处理时间还有 " + remaining + " 秒；请到时间后再实际发送。" : "可按原文和约束人工处理；保存时间是本机确认时间，不是平台精确回复时间。";
        save.Enabled = !checking && problem.Length == 0 && remaining == 0 && confirmed.Checked && !String.IsNullOrWhiteSpace(answer.Text); skip.Enabled = !checking;
    }
    async Task Submit(bool skipped) {
        if (checking || details == null) return;
        if (skipped && String.IsNullOrWhiteSpace(reason.Text)) { MessageBox.Show(this, "请填写跳过原因；前提不足可记录PRECONDITION_UNMET。", "需要原因"); return; }
        checking = true; UpdateReady();
        try {
            var result = await saver(new Dictionary<string, object> { { "stepId", TextOf(details, "stepId") }, { "answer", answer.Text },
                { "account", account.Text }, { "confirmed", confirmed.Checked }, { "skip", skipped }, { "reason", reason.Text } });
            if (IsDisposed) return;
            if (ObjectOf(result, "nextManual") != null) Apply(ObjectOf(result, "nextManual"));
            else { MessageBox.Show(this, BoolOf(result, "finished") ? "表内步骤已处理，结果已尝试生成。请回主窗口查看双份结果状态。" : "本步已保存。请关闭此窗口，回到自动测试账号后点击主界面“继续”。", "人工记录已保存"); Close(); }
        } catch (Exception e) { if (!IsDisposed) MessageBox.Show(this, e.Message, "人工记录未完成"); }
        finally { checking = false; if (!IsDisposed) UpdateReady(); }
    }
}
