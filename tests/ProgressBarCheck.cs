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
        CheckExecutableSettings();
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
        foreach (float scale in new float[] { 1F, 1.25F, 1.5F, 1.75F, 2F }) {
            using (var window = new RunnerWindow()) {
                // Never Show(): no backend, browser, account or network is started.
                window.Scale(new SizeF(scale, scale)); CreateHandles(window);
                typeof(RunnerWindow).GetField("ready", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, true);
                CheckWorkflow(window);
                var setButtons = typeof(RunnerWindow).GetMethod("SetButtons", BindingFlags.Instance | BindingFlags.NonPublic);
                var resultButton = Field<Button>(window, "generateExcel"); var control = Field<Button>(window, "runControl");
                typeof(RunnerWindow).GetField("canGenerateResults", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, true);
                setButtons.Invoke(window, new object[] { false, true, false });
                if (!resultButton.Enabled || !control.Enabled || control.Text != "暂停") throw new Exception("Snapshot and pause unavailable during sending");
                typeof(RunnerWindow).GetField("generatingResults", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, true);
                setButtons.Invoke(window, new object[] { false, true, false });
                if (resultButton.Enabled || !control.Enabled) throw new Exception("Duplicate generation must be blocked while pause remains available");
                typeof(RunnerWindow).GetField("generatingResults", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(window, false);
                Apply(window, Model(false, false, false));
                var bar = Field<CompletionBar>(window, "progress");
                foreach (int width in new int[] { 930, 980, 1360 }) {
                    window.ClientSize = new Size((int)(width * scale), (int)(840 * scale)); Layout(window);
                    var clean = Field<CheckBox>(window, "clean"); var start = Field<Button>(window, "start");
                    if (clean.Bottom > clean.Parent.ClientSize.Height - clean.Parent.Padding.Bottom || clean.Height < clean.PreferredSize.Height)
                        throw new Exception("Initial-state checkbox is clipped: scale=" + scale + ", width=" + width);
                    if (clean.PointToScreen(new Point(0, clean.Height)).Y > start.PointToScreen(Point.Empty).Y)
                        throw new Exception("Initial-state checkbox overlaps action row");
                    foreach (string name in new string[] { "start", "runControl", "exportCurrent", "generateExcel", "previewDataset", "openResult", "openBackups", "openFolder" }) {
                        var button = Field<Button>(window, name);
                        if (button.Left < 0 || button.Top < 0 || button.Right > button.Parent.ClientSize.Width || button.Bottom > button.Parent.ClientSize.Height)
                            throw new Exception("Button clipped: " + name + ", scale=" + scale + ", width=" + width);
                    }
                    if (bar.Left < bar.Parent.Padding.Left || bar.Right > bar.Parent.ClientSize.Width - bar.Parent.Padding.Right) throw new Exception("Progress extends beyond parent");
                    bar.SetProgress(35, 54);
                    using (var bitmap = new Bitmap(bar.Width, bar.Height)) {
                        bar.DrawToBitmap(bitmap, bar.ClientRectangle); int painted = 0;
                        for (int x = 0; x < bar.Width; x++) if (bitmap.GetPixel(x, bar.Height / 2).ToArgb() == Color.FromArgb(39, 96, 205).ToArgb()) painted++;
                        if (painted != (int)Math.Floor(bar.Width * 35.0 / 54)) throw new Exception("Window progress ratio mismatch");
                    }
                }
                string previewPath = Environment.GetEnvironmentVariable("DOUBAO_UI_PREVIEW");
                if (scale == 1F && !String.IsNullOrEmpty(previewPath)) {
                    window.ClientSize = new Size(980, 840); Apply(window, Model(false, false, true)); Layout(window);
                    using (var bitmap = new Bitmap(window.Width, window.Height)) { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size)); bitmap.Save(previewPath); }
                }
                Console.WriteLine("Window workflow, result context and layout OK, scale=" + scale);
            }
            using (var preview = new DatasetPreviewWindow(@"D:\test.xlsx", path => { throw new Exception("Preview check must not read a workbook"); })) {
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
    static void CheckExecutableSettings() {
        foreach (string saved in new string[] { "", @"D:\old\app\Doubao.exe" }) {
            using (var window = new RunnerWindow()) {
                var snapshot = Model(false, false, false);
                snapshot["settings"] = new Dictionary<string, object> { { "executable", saved } };
                var input = Field<TextBox>(window, "executable");
                Apply(window, snapshot);
                if (input.Text != saved) throw new Exception("Saved executable not loaded on first status");
                string selected = @"D:\new\app\Doubao.exe";
                input.Text = selected; // The picker writes this same Text property; the field is unfocused.
                for (int i = 0; i < 6; i++) Apply(window, snapshot);
                if (input.Text != selected) throw new Exception("Status polling erased or reverted the selected executable");
                var options = (Dictionary<string, object>)Call(window, "Options");
                if ((string)options["executable"] != selected) throw new Exception("Connect/launch lost the selected executable");
                input.Text = ""; Apply(window, snapshot);
                if (input.Text != "") throw new Exception("Status polling undid an intentional path clear");
            }
        }
        using (var window = new RunnerWindow()) {
            var input = Field<TextBox>(window, "executable");
            input.Text = @"D:\selected-before-first-status\app\Doubao.exe";
            var snapshot = Model(false, false, false);
            snapshot["settings"] = new Dictionary<string, object> { { "executable", "" } };
            Apply(window, snapshot);
            if (input.Text != @"D:\selected-before-first-status\app\Doubao.exe") throw new Exception("Delayed initial status erased a local selection");
        }
        Console.WriteLine("Executable: fresh/saved settings, repeated stale polling, command options, clear and initial-status race OK");
    }
    static T Field<T>(object instance, string name) { return (T)instance.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(instance); }
    static object Call(object instance, string method, params object[] args) { return instance.GetType().GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(instance, args); }
    static void Apply(RunnerWindow window, Dictionary<string, object> snapshot) { Call(window, "ApplyView", snapshot); }
    static Dictionary<string, object> Model(bool running, bool manual, bool result) {
        var run = new Dictionary<string, object> { { "id", "run-A" }, { "datasetId", "excel" }, { "purpose", "technical_regression" },
            { "inputName", "A.xlsx" }, { "inputPath", System.IO.Path.Combine(System.IO.Path.GetTempPath(), "A.xlsx") }, { "inputHash", "hash-A" },
            { "resumable", true }, { "status", manual ? "awaiting_manual" : running ? "running" : "paused" }, { "pauseRequested", false },
            { "manualAvailable", manual }, { "automaticCompleted", 4 }, { "automaticTotal", 5 }, { "manualCompleted", 0 }, { "manualTotal", 1 },
            { "total", 6 }, { "completed", 4 }, { "step", "S0005" }, { "target", "A::H01" }, { "activity", "本轮测试状态" }, { "canReviewRetry", false } };
        var output = new Dictionary<string, object> { { "available", true }, { "file", System.IO.Path.Combine(System.IO.Path.GetTempPath(), "run-A-result.xlsx") },
            { "kind", "stage" }, { "label", "阶段结果" }, { "processedRows", 4 }, { "totalRows", 6 }, { "stale", false } };
        var backup = new Dictionary<string, object> { { "path", System.IO.Path.Combine(System.IO.Path.GetTempPath(), "run-A-backups") }, { "label", "身份A · 自动会话备份" } };
        return new Dictionary<string, object> { { "active", running }, { "busy", false }, { "run", run },
            { "directory", System.IO.Path.GetTempPath() }, { "connection", new Dictionary<string, object>() },
            { "resultGeneration", new Dictionary<string, object> { { "available", true } } },
            { "artifacts", new Dictionary<string, object> { { "result", result ? output : null }, { "backups", result ? new object[] { backup } : new object[0] } } }, { "logs", new object[0] } };
    }
    static void CheckWorkflow(RunnerWindow window) {
        Apply(window, Model(false, false, false));
        var control = Field<Button>(window, "runControl"); var choose = Field<Button>(window, "previewDataset");
        if (!control.Enabled || control.Text != "继续本轮" || !choose.Enabled) throw new Exception("Paused task must allow resume and selecting a new file");
        string next = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "B.xlsx");
        var report = new Dictionary<string, object> { { "valid", true }, { "file", new Dictionary<string, object> { { "path", next }, { "sha256", "hash-B" } } } };
        Call(window, "BindExcelSelection", report);
        var start = (Dictionary<string, object>)Call(window, "BuildStartOptions"); var resume = (Dictionary<string, object>)Call(window, "BuildResumeOptions");
        if ((string)start["excelPath"] != next || (string)start["expectedPreviousRunId"] != "run-A" || !(bool)start["abandon"]) throw new Exception("New task must bind B and retain the previous run context");
        if (resume.ContainsKey("excelPath") || resume.Count != 1 || (string)resume["expectedRunId"] != "run-A") throw new Exception("Resume must not send B as the current input");
        if (!Field<Label>(window, "currentFileLabel").Text.Contains("A.xlsx") || !Field<Label>(window, "nextFileLabel").Text.Contains("B.xlsx")) throw new Exception("Current and next inputs are not distinct");
        var running = Model(true, false, false); Apply(window, running);
        if (control.Text != "暂停" || !control.Enabled || choose.Enabled) throw new Exception("Running task controls are inconsistent");
        ((Dictionary<string, object>)running["run"])["pauseRequested"] = true; Apply(window, running);
        if (control.Enabled || choose.Enabled || control.Text != "正在暂停…") throw new Exception("Pause request must not permit early file switching");
        Apply(window, Model(false, false, false)); if (!choose.Enabled || control.Text != "继续本轮" || Field<TextBox>(window, "excelFile").Text != next) throw new Exception("Pause acknowledgement lost the selected B input");
        Apply(window, Model(false, true, false)); if (control.Text != "处理人工步骤" || !control.Enabled || !Field<Label>(window, "headline").Text.Contains("后续仍有自动")) throw new Exception("Manual action or remaining AUTO state is misleading");
        Apply(window, Model(false, false, true));
        if (!Field<Button>(window, "openResult").Enabled || !Field<Button>(window, "openBackups").Enabled) throw new Exception("Existing outputs are not directly accessible");
        if (!((string)Call(window, "CurrentResultPath")).EndsWith("run-A-result.xlsx") || !Field<TextBox>(window, "excelFile").Text.EndsWith("B.xlsx")) throw new Exception("Result shortcut must follow A, not selected input B");
        if (!Field<Label>(window, "note").Text.Contains("阶段结果")) throw new Exception("Stage result is not labelled");
        var final = Model(false, false, true); var finalOutput = (Dictionary<string, object>)((Dictionary<string, object>)final["artifacts"])["result"];
        finalOutput["kind"] = "final"; finalOutput["label"] = "全流程结果"; finalOutput["processedRows"] = 6; Apply(window, final);
        if (!Field<Label>(window, "note").Text.Contains("全流程结果")) throw new Exception("Final result is not labelled");
        Apply(window, Model(false, false, false)); if (Field<Button>(window, "openResult").Enabled || Field<Button>(window, "openBackups").Enabled) throw new Exception("Missing outputs must not be presented as available");
        if (typeof(RunnerWindow).GetField("stop", BindingFlags.Instance | BindingFlags.NonPublic) != null) throw new Exception("Redundant Stop button remains");
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
