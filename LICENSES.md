# 许可证与来源（源码发布副本）

本目录是源码发布副本，不是本机运行目录的完整打包。根目录 LICENSE 保留原作者版权与许可文本，不能替代独立第三方依赖、桌面软件、模型服务和平台接口各自的授权。

| 内容 | 来源与范围 |
| --- | --- |
| Bridge 运行子集 | [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT；完整通知见 [组件 LICENSE](components/qq-bridge/LICENSE)；裁剪与修改说明见该目录 README |
| NT 数据库读取源码子集 | [zhuobichen/weflow-cli](https://github.com/zhuobichen/weflow-cli)，MIT；完整通知见 [组件 LICENSE](components/weflow-cli/LICENSE)；来源提交与修改范围见该目录 README |
| scripts/wechat_media.py | 同一 weflow-cli 来源版本中媒体辅助函数的复用，保留文件头来源说明和对应 MIT 通知 |
| scripts/wechat_sticker.py | 本项目新增绑定和下载逻辑；缓存布局及 CBC 约定参考同一 MIT 上游，保留来源说明 |
| imageio-ffmpeg | 独立安装的 Python 包，BSD-2-Clause；其 FFmpeg 程序按构建自带许可使用，本源码副本不分发二进制，见 [包元数据](https://pypi.org/project/imageio-ffmpeg/0.6.0/) |
| 有权独立授权的本项目新增代码、桌面界面及已授权人格预设 | 依根目录许可的适用范围，不扩大到维护者无权授权的内容 |
| 安装时获取的 SDK 和 Python 包 | 各自原许可与依赖声明；副本不包含 node_modules 或解释器环境 |

来源记录见 [components.json](components.json)。原作者版权和完整许可文本保留，代码子集及修改范围单独标记。

## 独立准备的外部内容

- 维护者已确认当前使用组件的再分发授权。本公开源码副本仍不包含第三方 WeChat-Hook 原始源码或二进制；本项目覆盖层单独保留。授权声明不替换上游自身许可。
- 原 WeFlow 与历史 WeFlowBackup 不包含在本目录中。今后引入其源码时，应保留原作者与 CC BY-NC-SA 4.0 许可，遵守适用的署名、非商业和改编共享条件。
- 微信、DSH 程序、原生预编译资源、第三方素材、截图、聊天及访问凭据不在源码发行范围内。五份已授权人格明确作为预设文件发布，用户安装后的账号配置和人格编辑不随源码分发。
- 本项目覆盖层不包含第三方 Hook 的原实现，编译与运行仍有独立授权及兼容性前置条件。

公开可见不等于一般再分发许可，见 [GitHub 许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。本说明不是法律或平台授权保证，也不自动授予商标、账号数据或独立第三方内容的权利。

## 本地语音测试

鲸鱼本地语音测试可选安装 [Vosk](https://github.com/alphacep/vosk-api)（Apache-2.0）和 [python-sounddevice](https://github.com/spatialaudio/python-sounddevice)（MIT）。语音模型单独下载并按各模型许可使用；源码仓库不分发模型或 Python 依赖二进制。音频工作进程为本项目新增实现。

## Weather data services

Weather forecasts are fetched from [Open-Meteo](https://open-meteo.com/) and locations from its GeoNames-backed geocoding API. Data is provided under [CC BY 4.0](https://open-meteo.com/en/licence); source attribution is retained in the model evidence and links. The default public API is for personal/non-commercial use and subject to [Open-Meteo terms and request limits](https://open-meteo.com/en/terms). Commercial use requires a suitable provider subscription or a separately operated service. No provider source code is bundled.

网页正文提取使用 [htmlparser2 10.0.0](https://github.com/fb55/htmlparser2/tree/v10.0.0)（MIT）；锁文件固定依赖，安装包保留 htmlparser2、entities、domhandler、domutils 等各自的 LICENSE。网页工具的网络地址校验复用 MIT Bridge 的 safe-fetch 逻辑，来源许可见 `components/qq-bridge/LICENSE`。仅使用本机 DNS 解析；代理返回 Fake-IP 时按非公开地址拒绝，不向额外 DNS 服务发送网页域名。

## 2026-10-27：B站、接听与声音复用

- [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，MIT，固定参考提交 `8b0009f8ce2ebdc421afcb2e727b19ac18912ec6`。`packages/jingyu/vendor/bili-whale-read.mjs` 改编其 WBI 签名与评论投影纯函数；保留版权和 `bili-whale-LICENSE.txt`。移除了上游 CLI、用户主目录读写、主动分享、私信、评论发布和轮询，账户登录状态只保留在本项目浏览器会话。
- [jiatj/wechatapi](https://github.com/jiatj/wechatapi)，Apache-2.0，固定提交 `04ef8cbde3862cff90b5f6b42c9ebfcea44ef48d`。复用 `uia_driver.py` 为 `packages/jingyu/vendor/wechat_uia.py`，唯一上游文件修改是把日志导入替换为标准 logging，原许可见 `wechatapi-LICENSE.txt`。宿主包装层只使用项目客户端的辅助功能与 UIA 控件，不调用上游自动登录、客户端启动或主动拨号路径。接听适配与身份、状态核验由本项目新增模块实现。
- [rany2/edge-tts](https://github.com/rany2/edge-tts)，运行依赖锁定 `7.3.1`；其主体为 LGPL-3.0，`srt_composer.py` 为 MIT。通过独立、可替换的 Python 安装包调用，未将其实现复制为本项目 MIT 源码。许可文字保存在 `edge-tts-LICENSE.txt` 与 `edge-tts-GPL-3.0.txt`；分发独立运行环境时须保留包内版权、许可及对应源码获取方式。
- 中文识别模型 `vosk-model-small-cn-0.22` 来自 [Vosk 官方模型页](https://alphacephei.com/vosk/models)，Apache-2.0。源码仅保存下载地址和 SHA256，不分发模型二进制。
- 新增运行依赖 uiautomation、comtypes、pywin32、aiohttp 和 imageio-ffmpeg 各自许可随其独立安装包保留。imageio-ffmpeg 中的 FFmpeg 二进制另受其构建许可约束。

研究过 `juntaochi/meituan-cli`，本次抓取未见明确许可文件或 package license，未复制其源码；外卖页面操作复用已存在的 Electron/Chromium，适配层由本项目实现。`HaonanYu123/JD-Taobao-MCP`（MIT）作为可见浏览器操作的参考，本次未复制其代码。Voicemeeter Banana 为独立的 VB-Audio 软件，不是本项目源码或开源依赖，安装、许可和音频驱动由用户另行决定。
