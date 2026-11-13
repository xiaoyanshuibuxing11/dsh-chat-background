# dsh-chat-background

给 DeepSeek Harness 桌面端 / Web 客户端换一张壁纸：本地或远程的图片，或循环播放的视频。背景铺在整个界面后面，外壳与侧栏底色变透明，消息气泡、输入框等卡片表面保持原样，文字仍然可读。

## 功能

- 图片默认内联为 `data:` URL，不额外发请求；视频默认走流式路由 `/dsh-chat-bg/media`（支持 `Range`，可拖动进度）。
- 不透明度、磨砂度、图片/视频路径都在「设置 → 通用 → 聊天背景」里改：前两项输入即生效，路径回车即应用。
- 配置缺失、空路径或读不到文件时只记一条 warning，不会让 DeepSeek Harness 启动失败；配置了却读不到图时，换一张图仍可当场生效。
- 不透明度与磨砂度存在浏览器 `localStorage`，只属于本机这个窗口，不随 profile 同步。

## 安装

1. 把本仓库放到本机任意目录。
2. 方式一：侧栏 → 插件 → 添加插件 → 粘贴本目录的绝对路径 → 安装 → 启用。
   方式二：在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: chat-background
         name: dsh-chat-background
         config:
           media: ''
           mode: auto
   ```

3. 重启 DeepSeek Harness（宿主侧的行只在启动时装载一次），然后进「设置 → 通用」调数值。

## 设置

「设置 → 通用 → 聊天背景」有三个填空：

| 字段 | 默认 | 说明 |
|---|---|---|
| 不透明度 | `50` | 0 = 完全看不见，100 = 原图。数值越低画面越淡。 |
| 磨砂度 | `0` | 0 = 锐利，100 ≈ 40px 高斯模糊。 |
| 图片路径 | 当前背景 | 图片或视频的完整路径，回车或点「应用」。 |

路径可以写 `C:/path/to/wall.jpg` 这类本地绝对路径（Windows 用正斜杠或双反斜杠），也可以写 `http(s)` 或 `data:` URL。

## 配置项

`cordis.patch.yml` 的 `config` 里可写：`media`、`type`（auto/image/video）、`mode`（auto/inline/route）、`opacity`、`blur`、`fit`、`position`、`dim`、`scrim`、`transparentSurfaces`、`fallback`。改完重启 DeepSeek Harness 生效。

## 数据与边界

- 不透明度与磨砂度存在 `localStorage`：`dsh-chat-background:opacity`、`dsh-chat-background:blur`。
- 配置在宿主侧启动时读取一次；页面上的数值改动即时生效，不需要重启。
- 仓库不含密钥；媒体文件不随仓库分发，由使用者自行指定。

## 目录

```
.
├── lib/index.js       宿主半侧：注入 style/script、内联图片、视频流式路由
├── lib/client.js      浏览器半侧：设置页的聊天背景行
├── package.json       bundle 与 DeepSeek Harness.client 声明
└── cordis.patch.yml   装载器补丁
```
