using System;
using System.Drawing;
using System.Windows.Forms;
using System.Reflection;
using System.Collections.Generic;
using System.Threading.Tasks;
internal static class ProgressBarCheck {
    [STAThread]
    static void Main() {
        try { Run(); }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().FullName + ": " + error.Message); Environment.Exit(1); }
    }
    static void Run() {
        Application.EnableVisualStyles();
        using (var bar = new CompletionBar()) {
            bar.Size = new Size(400, 12);
            for (int completed = 0; completed <= 4; completed++) {
                bar.SetProgress(completed, 4);
                using (var bitmap = new Bitmap(400, 12)) {
                    bar.DrawToBitmap(bitmap, new Rectangle(0, 0, 400, 12));
                    int painted = 0;
                    for (int x = 0; x < 400; x++) if (bitmap.GetPixel(x, 6).ToArgb() == Color.FromArgb(39, 96, 205).ToArgb()) painted++;
                    if (painted != completed * 100) throw new Exception("Progress mismatch: " + completed + "/4, painted=" + painted);
                    Console.WriteLine(completed + "/4 = " + completed * 25 + "% OK");
                }
            }
        }
        foreach (float scale in new float[] { 1F, 1.25F, 1.5F }) {
            using (var window = new RunnerWindow()) {
                // Never Show(): no backend, browser, account or network is started.
                window.Scale(new SizeF(scale, scale));
                typeof(RunnerWindow).GetField("ready", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, true);
                typeof(RunnerWindow).GetField("canGenerateResults", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, true);
                var setButtons = typeof(RunnerWindow).GetMethod("SetButtons", BindingFlags.Instance | BindingFlags.NonPublic);
                var resultButtonForState = (Button)typeof(RunnerWindow).GetField("generateExcel", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window);
                var pauseButtonForState = (Button)typeof(RunnerWindow).GetField("pause", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window);
                var manualButtonForState = (Button)typeof(RunnerWindow).GetField("manualSteps", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window);
                typeof(RunnerWindow).GetField("canHandleManual", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, true);
                setButtons.Invoke(window, new object[] { true, false, false });
                if (!manualButtonForState.Enabled) throw new Exception("Available manual step cannot be opened");
                setButtons.Invoke(window, new object[] { false, true, false });
                if (!resultButtonForState.Enabled || !pauseButtonForState.Enabled) throw new Exception("Cannot generate a snapshot or pause during sending");
                typeof(RunnerWindow).GetField("generatingResults", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, true);
                setButtons.Invoke(window, new object[] { false, true, false });
                if (resultButtonForState.Enabled || !pauseButtonForState.Enabled) throw new Exception("Generation must prevent duplicate export but still allow pause");
                typeof(RunnerWindow).GetField("generatingResults", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, false);
                var field = typeof(RunnerWindow).GetField("progress", BindingFlags.Instance | BindingFlags.NonPublic);
                var bar = (CompletionBar)field.GetValue(window);
                foreach (int width in new int[] { 930, 980, 1360 }) {
                    window.ClientSize = new Size((int)(width * scale), (int)(760 * scale));
                    Layout(window);
                    var exportField = typeof(RunnerWindow).GetField("exportCurrent", BindingFlags.Instance | BindingFlags.NonPublic);
                    var exportButton = (Button)exportField.GetValue(window);
                    if (exportButton.Right > exportButton.Parent.ClientSize.Width || exportButton.Bottom > exportButton.Parent.ClientSize.Height)
                        throw new Exception("Export button is clipped: " + scale + ", " + width);
                    var resultField = typeof(RunnerWindow).GetField("generateExcel", BindingFlags.Instance | BindingFlags.NonPublic);
                    var resultButton = (Button)resultField.GetValue(window);
                    if (resultButton.Left < 0 || resultButton.Right > resultButton.Parent.ClientSize.Width || resultButton.Bottom > resultButton.Parent.ClientSize.Height)
                        throw new Exception("Result button is clipped: " + scale + ", " + width);
                    var previewField = typeof(RunnerWindow).GetField("previewDataset", BindingFlags.Instance | BindingFlags.NonPublic);
                    var previewButton = (Button)previewField.GetValue(window);
                    if (previewButton.Left < 0 || previewButton.Right > previewButton.Parent.ClientSize.Width || previewButton.Bottom > previewButton.Parent.ClientSize.Height)
                        throw new Exception("Dataset preview button is clipped: " + scale + ", " + width);
                    if (bar.Left < bar.Parent.Padding.Left || bar.Right > bar.Parent.ClientSize.Width - bar.Parent.Padding.Right)
                        throw new Exception("Progress extends beyond visible parent: " + scale + ", " + width);
                    bar.SetProgress(35, 54);
                    using (var bitmap = new Bitmap(bar.Width, bar.Height)) {
                        bar.DrawToBitmap(bitmap, bar.ClientRectangle);
                        int painted = 0;
                        for (int x = 0; x < bar.Width; x++) if (bitmap.GetPixel(x, bar.Height / 2).ToArgb() == Color.FromArgb(39, 96, 205).ToArgb()) painted++;
                        int expected = (int)Math.Floor(bar.Width * 35.0 / 54);
                        if (painted != expected) throw new Exception("Window progress mismatch: " + painted + " vs " + expected);
                    }
                }
                Console.WriteLine("Window layout and 35/54 pixels OK, scale=" + scale);
            }
            using (var preview = new DatasetPreviewWindow(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "preview-test.xlsx"), path => { throw new Exception("Preview check must not read a workbook"); })) {
                preview.Scale(new SizeF(scale, scale));
                CreateHandles(preview);
                var apply = typeof(DatasetPreviewWindow).GetMethod("ApplyReport", BindingFlags.Instance | BindingFlags.NonPublic);
                var flow = (DataGridView)typeof(DatasetPreviewWindow).GetField("flow", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(preview);
                var issues = (DataGridView)typeof(DatasetPreviewWindow).GetField("issues", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(preview);
                var body = (TextBox)typeof(DatasetPreviewWindow).GetField("fullMessage", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(preview);
                string original = "  完整发送原文\n结尾空格  ";
                var step = new Dictionary<string, object> { { "order", 1 }, { "stepId", "S0001" }, { "identityId", "A" }, { "conversationId", "M01" },
                    { "mode", "AUTO" }, { "messageType", "HISTORY" }, { "navigationLabel", "新建并命名" }, { "waitSeconds", 30 }, { "sourceRow", 2 }, { "content", original } };
                var counts = new Dictionary<string, object> { { "total", 1 }, { "automatic", 1 }, { "manual", 0 }, { "questions", 0 },
                    { "conversations", 1 }, { "automaticConversations", 1 }, { "errors", 0 }, { "warnings", 0 } };
                var report = new Dictionary<string, object> { { "valid", true }, { "summary", counts }, { "steps", new object[] { step } }, { "issues", new object[0] } };
                apply.Invoke(preview, new object[] { report });
                var use = (Button)typeof(DatasetPreviewWindow).GetField("use", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(preview);
                if (!use.Enabled) throw new Exception("Valid preview cannot be selected for execution");
                if (!flow.ReadOnly || !issues.ReadOnly || !body.ReadOnly || body.Text.Replace("\r\n", "\n") != original || flow.Rows.Count != 1)
                    throw new Exception("Preview must remain read-only and preserve full message text");
                foreach (int width in new int[] { 1000, 1180, 1360 }) {
                    preview.ClientSize = new Size((int)(width * scale), (int)(800 * scale)); Layout(preview);
                    foreach (string name in new string[] { "choose", "validate" }) {
                        var button = (Button)typeof(DatasetPreviewWindow).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(preview);
                        if (button.Left < 0 || button.Right > button.Parent.ClientSize.Width || button.Bottom > button.Parent.ClientSize.Height)
                            throw new Exception("Preview file button is clipped: " + name + ", scale=" + scale);
                    }
                    if (body.Height < 60 || flow.Height < 150) throw new Exception("Preview details or grid collapsed: body=" + body.Height + ", grid=" + flow.Height);
                }
                var invalid = new Dictionary<string, object> { { "valid", false }, { "summary", counts }, { "steps", new object[0] },
                    { "issues", new object[] { new Dictionary<string, object> { { "severity", "error" }, { "sheet", "全过程执行表" }, { "row", 2 }, { "column", "G" }, { "message", "等待时间不是整数" } } } } };
                apply.Invoke(preview, new object[] { invalid });
                if (flow.Rows.Count != 0 || body.Text.Length != 0 || issues.Rows.Count != 1 || use.Enabled) throw new Exception("Invalid preview retained stale messages or enabled execution");
                Console.WriteLine("Dataset preview read-only, full text, stale clearing and layout OK, scale=" + scale);
            }
            using (var manual = new ManualStepWindow(() => { throw new Exception("Must not load from backend in window check"); }, input => { throw new Exception("Must not submit during window check"); })) {
                manual.Scale(new SizeF(scale, scale)); CreateHandles(manual);
                var apply = typeof(ManualStepWindow).GetMethod("Apply", BindingFlags.Instance | BindingFlags.NonPublic);
                var answer = (TextBox)typeof(ManualStepWindow).GetField("answer", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(manual);
                var instructions = (TextBox)typeof(ManualStepWindow).GetField("instructions", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(manual);
                var check = (CheckBox)typeof(ManualStepWindow).GetField("confirmed", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(manual);
                var save = (Button)typeof(ManualStepWindow).GetField("save", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(manual);
                var details = new Dictionary<string, object> { { "stepId", "S0005" }, { "identityId", "B" }, { "conversationId", "H01" },
                    { "content", "人工发送原文" }, { "constraint", "人工前置要求" }, { "readyAt", 0 }, { "remaining", 1 }, { "defaultAccount", "account-B" } };
                apply.Invoke(manual, new object[] { details }); if (save.Enabled || !instructions.ReadOnly) throw new Exception("Manual step must require explicit confirmation and reply");
                answer.Text = "首次完整人工回复"; check.Checked = true; if (!save.Enabled) throw new Exception("Confirmed manual reply cannot be saved");
                foreach (int width in new int[] { 900, 980, 1180 }) {
                    manual.ClientSize = new Size((int)(width * scale), (int)(780 * scale)); Layout(manual);
                    if (save.Right > save.Parent.ClientSize.Width || save.Bottom > save.Parent.ClientSize.Height || answer.Height < 120) throw new Exception("Manual step controls clipped: " + save.Bottom + "/" + save.Parent.ClientSize.Height + ", answer=" + answer.Height);
                }
                Console.WriteLine("Manual step confirmation, reply and layout OK, scale=" + scale);
            }
        }
    }
    static void Layout(Control control) {
        control.PerformLayout();
        foreach (Control child in control.Controls) Layout(child);
    }
    static void CreateHandles(Control control) {
        var handle = control.Handle;
        foreach (Control child in control.Controls) CreateHandles(child);
    }
}
