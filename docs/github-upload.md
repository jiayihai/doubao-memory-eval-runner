# 更新 GitHub 仓库

本地“豆包测评执行器_GitHub发布版”是可上传的当前快照，来源于唯一开发主线。它包含 README、安装入口、锁文件和合成测试表；不含 node_modules、真实运行记录或私有表格运行库。版本目录“豆包测评执行器_GitHub发布版_1.8.1”保留同一版本快照。旧 1.6.0 已移到本地发布归档。

## 上传内容

仓库根目录应直接看到 README.md、package.json、安装依赖.cmd、core/、ui/、examples/ 等，不要在根目录外面再套一层发布文件夹。

更新已有仓库时，推荐用 Git 或 GitHub Desktop 同步整个快照并审阅新增、修改、删除项，再提交和推送。这样旧文件的删除也能同步。浏览器上传时，在仓库点击 Add file → Upload files，将发布目录里的文件及子文件夹一起拖入上传区域；系统的“选择文件”对话框不能直接选文件夹。单纯追加上传不会自动删除仓库旧文件。

项目现有仓库为 https://github.com/jiayihai/doubao-memory-eval-runner 。本次仅整理本地发布目录和 ZIP，没有替作者推送线上。

从1.8.0更新到1.8.1时，在仓库首页上传新版发布目录内的全部文件。两个新版启动文件名带1.8.1；上传后，仅删除旧“豆包测评执行器V1_1.8.0.exe”和同名“.exe.config”，其余新版文件保留。执行设置.json、构建窗口.ps1、package.json等须在仓库根目录；不要在tools子目录中上传根目录文件。新快照仍为75个文件。

## 建议填写

- 仓库简介：Windows 豆包桌面端长期记忆测评工具，支持 Excel 流程驱动、暂停恢复、回复备份与结果回填。
- 提交说明：Update v1.8.1 public installation, user guide and starter workbook
- 如创建 Release：标签 v1.8.1，标题 V1.8.1：公开依赖与入门指南，附件使用 doubao-memory-eval-runner-1.8.1.zip。

exe 可以作为 Release 附件随 ZIP 提供；源码仓库通过安装依赖.cmd 自动安装依赖并构建 exe。安装后产生的 node_modules、运行数据、对话导出和结果表不上传。不要只上传 ZIP 而省略仓库源码，否则访问者不方便直接阅读 README 和代码。
