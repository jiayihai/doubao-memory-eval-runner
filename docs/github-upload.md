# 上传到GitHub

此目录已经整理为仓库根目录，尚未连接账号或上传。

1. 登录自己的GitHub，创建仓库，可命名为doubao-memory-eval-runner；面试直接分享可选择Public，可见性由本人决定。
2. 使用GitHub网页的Add file → Upload files，上传**这个目录内部的文件与子目录**，包括README.md、.gitignore和.gitattributes；不要上传整个项目开始或面试归档目录。
3. 提交后，浏览器中该仓库的URL就是可分享链接。根README会展示项目介绍。

官方操作说明：[上传文件到仓库](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)。

如果使用Git工具，先在仓库目录检查git status，确认没有运行数据、node_modules、.env、真实结果或本机配置，再提交。不要使用包含运行记录的原开发目录执行git add .。

本次未选择开源许可证；需要开放代码使用权限时，由项目作者另行选择。也没有提供exe下载或独立安装包。后续若发布Release，需明确其运行依赖，不能把专用外部表格运行库一并上传。
