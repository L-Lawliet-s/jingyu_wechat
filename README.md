# 鲸鱼 · Jingyu WeChat

基于 [WeChatAgent](https://github.com/sourcepro5/WeChatAgent) 的个人微信 AI 伙伴桌面端。

开发仓库：[L-Lawliet-s/jingyu_wechat](https://github.com/L-Lawliet-s/jingyu_wechat)。本项目直接升级宿主源码，保留微信、DSH 与已有数据兼容性。

**首次使用请看：[从零开始配置教程](docs/GETTING_STARTED.md)。** 微信读取和语音使用的 Python 均由软件自动检测、下载与配置，无需安装系统 Python、修改 PATH 或填写解释器路径。

目标包括桌面和聊天余额查询、主人记忆单向共享、管理员任务、学习提醒，以及经过验证的拍一拍、语音和通话动作。

升级顺序与验收边界见 [开发计划](docs/JINGYU_UPGRADE.md)。原版说明保存在 [上游使用说明](docs/UPSTREAM_README.md)。

当前支持原生余额、自动聊天记忆、学习提醒、“会聊天的小助手”、B站资料/字幕/评论与受控外卖页面操作。主人可回忆各联系人的聊天，联系人只能回忆本人和主人的可分享内容，见 [聊天记忆规则](docs/CONVERSATION_MEMORY.md)。已加入语音/视频来电接听适配、可爱女声和视频画面占位；实际通话须配置独立音频通道后验收。主动拨号按用户要求不提供，拍一拍与微信原生语音消息仍待开发。使用与实测边界见 [新功能与接听配置](docs/COMPANION_PLATFORMS_CALLS.md)。

实际检查与尚未完成的实机项目见 [验证记录](docs/JINGYU_VERIFICATION.md)。

新版逐项验收见 [完整测试方案](docs/FULL_FEATURE_TEST_PLAN.md)：107 个基础用例，覆盖新功能、权限隔离、异常恢复和旧功能回归。

微信首次连接的自动初始化、组件准备及实机结果见 [连接修复说明](docs/WECHAT_CONNECTION_FIX.md)。

账号、密钥和运行数据不进入 Git。初始导入保留上游提交历史、[LICENSE](LICENSE) 和 [第三方来源与许可](LICENSES.md)。上游基线为 5cdedddc60936c550ce5c02558eb025a5350f48e。
