# 鲸鱼 · Jingyu WeChat

基于 [WeChatAgent](https://github.com/sourcepro5/WeChatAgent) 的个人微信 AI 伙伴桌面端。

开发仓库：[L-Lawliet-s/jingyu_wechat](https://github.com/L-Lawliet-s/jingyu_wechat)。本项目直接升级宿主源码，保留微信、DSH 与已有数据兼容性。

**首次使用请看：[从零开始配置教程](docs/GETTING_STARTED.md)。** 微信读取和语音使用的 Python 均由软件自动检测、下载与配置，无需安装系统 Python、修改 PATH 或填写解释器路径。

目标包括桌面和聊天余额查询、主人记忆单向共享、管理员任务、学习提醒，以及经过验证的拍一拍、语音和通话动作。

升级顺序与验收边界见 [开发计划](docs/JINGYU_UPGRADE.md)。原版说明保存在 [上游使用说明](docs/UPSTREAM_README.md)。

当前已加入原生余额、单向共享记忆、学习提醒及手动语音测试入口。自动拍一拍、原生语音消息、AI 自主电话和平台专用操作仍在计划阶段；不能把本次源码版当成全部完成的正式版。使用步骤见 [鲸鱼配置指南](docs/JINGYU_SETUP.md)。

实际检查与尚未完成的实机项目见 [验证记录](docs/JINGYU_VERIFICATION.md)。

微信首次连接的自动初始化、组件准备及实机结果见 [连接修复说明](docs/WECHAT_CONNECTION_FIX.md)。

账号、密钥和运行数据不进入 Git。初始导入保留上游提交历史、[LICENSE](LICENSE) 和 [第三方来源与许可](LICENSES.md)。上游基线为 5cdedddc60936c550ce5c02558eb025a5350f48e。
