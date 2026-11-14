# Hexo Blog Console

给 Hexo 博客用的**本地可视化控制台**：写文章、看预览、一键发布，全程不碰命令行。

![screenshot](docs/screenshot.png)

> 一个跑在本机的小型 Web 应用（Node + 原生 JS，零额外依赖），只监听 `127.0.0.1`。
> Windows 上双击图标即以无边框窗口打开，像桌面软件一样用。

## 为什么

用 Hexo 写博客，日常动作其实就是三件：新建文件、本地预览、构建部署。但这三件事分别对应
`hexo new`、`hexo server`、`hexo clean && hexo g && hexo d`，每次都要开终端、记命令、等构建。
这个工具把它们变成三个按钮，并且顺手把「源码版本管理」也接上了。

## 功能

- **文章列表**：按日期排序，支持标题 / 标签搜索，显示字数和草稿标记
- **Markdown 编辑**：左右分栏，实时预览（复用博客自己的 `marked`，样式和线上一致）
- **元信息面板**：标题、日期、标签、分类、描述、封面，改完只更新 front-matter，不动正文
- **新建文章**：自动生成带 front-matter 的 md，可选「草稿」（`_` 前缀，Hexo 不生成页面）
- **删除保护**：删掉的文移入 `_trash/` 回收站，不是真删
- **自动保存**：停止输入 4 秒自动落盘（不提交），Ctrl+S 保存并提交
- **git 自动提交**：保存 / 发布时自动 `git add` + `commit`；右上角状态灯显示是否同步
- **本地预览**：一键起 `hexo server` 并打开浏览器，再点一次停止
- **一键发布**：`clean → generate → deploy`，底部实时滚动日志，任一步失败立即中断
- **深色 / 浅色主题**：跟随按钮切换，记忆在 localStorage

## 环境要求

- Node.js >= 18
- 一个 **Hexo** 博客项目（需要 `hexo-cli` 与 `hexo-deployer-git` 已安装）
- Windows 10/11（用 `start.vbs` 启动）或 macOS / Linux（用 `start.sh`）

## 快速开始

1. 把这个目录放到任意位置，例如 `D:\tools\blog-console`
2. 复制配置并填写你的博客路径：

```bash
cp config.example.json config.json
```

```json
{
  "blogDir": "D:/my-blog",
  "port": 4180,
  "siteUrl": "https://username.github.io/",
  "defaultCover": ""
}
```

3. 启动：

- **Windows**：双击 `start.vbs`（推荐，会隐藏控制台窗口）
- **macOS / Linux**：`./start.sh`
- **任意平台**：`node server.js`，然后打开 <http://127.0.0.1:4180>

### 可选：创建桌面快捷方式（Windows）

右键 `start.vbs` → 发送到 → 桌面快捷方式；想换图标就右键快捷方式 → 属性 → 更改图标。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `blogDir` | `''` | **必填**，Hexo 博客根目录（含 `_config.yml` 的那层） |
| `port` | `4180` | 控制台端口，只监听 127.0.0.1 |
| `siteUrl` | `''` | 线上地址，填了才显示「网站」按钮 |
| `defaultCover` | `''` | 新建文章时的默认封面 |
| `postsDir` | `source/_posts` | 文章目录 |
| `hexoBin` | `node_modules/hexo-cli/bin/hexo` | hexo 入口，相对博客根目录 |
| `previewPort` | `4000` | `hexo server` 的端口 |
| `autoSaveMs` | `4000` | 自动保存的空闲间隔 |

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl + S` | 保存并提交 git |
| `Ctrl + N` | 新建文章 |
| `Esc` | 关闭新建弹窗 |

## 工作原理

```
浏览器窗口 (Edge --app 模式或任意浏览器)
        │  HTTP  127.0.0.1:4180
        ▼
   server.js  ──►  读写 source/_posts/*.md
        │            git add / commit
        │            hexo clean / generate / deploy
        ▼
   blogDir (你的 Hexo 项目)
```

- 服务端**没有第三方依赖**，只用了 Node 内置的 `http` / `fs` / `child_process`
- Markdown 渲染复用博客 `node_modules` 里的 `marked`，所以预览效果和线上一致
- 所有写操作都限定在 `postsDir` 内，文件名经过 `path.basename` 过滤，杜绝路径穿越
- 启动后会把真实端口写进 `.port`，启动器读它来决定打开哪个地址（改端口不用改脚本）

## 常见问题

**Q: 双击 `start.vbs` 报「未结束的字符串常量」？**
A: 这个脚本必须以 **UTF-16LE + BOM** 保存。如果你用编辑器改过它，记得另存为这种编码；或者直接双击 `start.bat`（有窗口，能看到报错）。

**Q: 提示端口被占用？**
A: 说明已经有一个实例在跑。服务端检测到 `EADDRINUSE` 会直接退出，不会重复启动；直接打开 <http://127.0.0.1:4180> 即可。

**Q: 点发布没有反应 / 卡住？**
A: 看底部日志。最常见的是 GitHub 凭据失效（`git credential` 没配好）或网络问题。可以先在博客目录手动跑一次 `hexo deploy` 排查。

**Q: 预览报错找不到 marked？**
A: 需要博客装过 `hexo-renderer-marked`（Hexo 默认就有）。没有时会退化成纯文本预览，不影响写作。

**Q: 会不会把我的文章传到网上？**
A: 不会。控制台只监听本机回环地址，除了你自己触发的 `hexo deploy` 之外不发起任何外部请求。

## 许可

[MIT](LICENSE)
