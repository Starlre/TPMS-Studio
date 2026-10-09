# Electron 界面开发与运行

更新时间：2026-10-09 23:55:13（Asia/Shanghai）。R-056 实现 Electron 工作台；R-057 在 G 盘修复后同步完整源码、运行依赖和开发脚本。

## 运行

本机 Python 为 `D:/anaconda3/python.exe`。双击项目根目录 `启动Electron.cmd` / `run_tpms.bat`，或者执行：

```powershell
python launch_desktop.py
```

启动器使用当前 Python 解释器作为建模后端。需要安装 Node.js 22.12+，建议 24 LTS，以及 `requirements.txt` 中的 Python 依赖。libfive 仍按原项目原生库布局加载，缺少该库时 TPMS 连续场建模可用，实体组合明确禁用。

首次启动安装 npm 依赖并构建界面，后续只在源文件更新时重新构建。Electron 默认下载失败时，仅对本次安装尝试 `npmmirror`；可以提前设置自己的 `ELECTRON_MIRROR`。此行为不改变系统 npm 配置。无需联网加载字体、图标或模型。

`run_qt.bat` / `python app.py` 保留原 Qt 兼容入口。当前尚无带 Python/native 运行时的独立 EXE 安装包。

## 分层

```text
React 参数 / 对象树 / 质量报告
              ↓ 受限 preload IPC
Electron 主进程：原生文件对话框、请求白名单、二进制网格传输
              ↓ 私有 stdin / stdout JSON-lines
独立 Python 进程：electron_backend.py
              ↓
tpms_core.py / solid_model.py / libfive_backend.py / comsol_mesh.py
```

Three.js 只处理视图。完整网格按 float32 顶点 + uint32 索引的二进制文件传入 Electron，避免百万级 JSON 数组。传输文件位于程序创建的独立临时目录，读取后删除；关闭程序清理临时数据。正式导出由本机文件对话框确定目标，采用临时文件完成后替换的方式保留已有文件。

渲染进程关闭 Node 集成，启用 contextIsolation、sandbox 和 CSP；阻止新窗口及外部导航，不开放任意 shell 命令或任意文件系统 API。Python 的数学公式仍由现有安全解析器执行。

生成、导出、CFD 分析在独立 Python 进程串行运行。取消直接终止计算进程，后续启动新进程，必须重新生成模型。CFD 中的原多进程分域加速暂时关闭，减少桌面进程退出后残留子进程的风险；现有 Gmsh 本机计算仍保留。

## 视口

- 内置五种 TPMS 的片层/实体/梯度使用现有数学场 GLSL，适配 WebGL2；传入孔隙率求解后的参数，公式不拼接用户输入。
- GPU 隐式预览叠加在完整网格底图上，由清理后网格的 stencil 轮廓限制显示范围。射线漏采样时保留网格底图，已清理的游离组件不会重新出现在隐式视图。
- 自定义公式、管状卷绕、实体组合、仿真区域、低质量定位和线框均使用网格显示。着色器编译失败回退网格。
- 相机采用 Z 向上；XYZ 字母方向标与相机旋转一致；恢复视角后完整模型适配窗口。
- 按需 requestAnimationFrame 渲染，阻尼结束后停止绘制。拖动降低像素比，松开后恢复；切换模型时显式释放 GPU 几何与材质。
- 当前混合预览轮廓仍受生成网格精度影响；不是无限精度几何，也未声称达到 nTop 的复杂场性能。未测定正式 FPS 基准。

## 功能与快照

TPMS 参数包括五种内置曲面、自定义公式、尺寸、周期、片层/实体、孔隙率、梯度、卷绕、采样数及连续场/libfive 内核。自定义公式输入时隐藏周期控件，参数验证由 Python 最终执行。

实体组合支持球、长方体、圆柱、圆环、TPMS；位置、旋转、复制、受引用对象删除保护；并集、交集、差集、基本体平滑融合；最终输出选择与三个示例。TPMS 对象保存独立参数快照，可用按钮更新为当前 TPMS 参数。组合仍沿用已有 64 对象、无循环和网格规模限制。

模型统计和导出始终对应成功生成的快照。修改建模参数会标记未生成，禁止导出与 CFD；CFD 设置单独改变时只使质量结果失效。诊断使用已求解后的生成参数，避免二次孔隙率求解。目标孔隙率与梯度互斥，实体模式禁用梯度。

导出质量/面数集中在顶部“导出”菜单，包括原始、高、中、低、自定义面数和 TPMS libfive 重算。简化沿用原有方法，实际面数和水密性显示在状态栏；正式仿真应优先使用水密的原始或验证过的网格。

JSON 项目保存参数、对象、组合关系、CFD 设置；兼容读取旧实体组合 JSON。保存项目不等于保存网格，打开项目后需生成。快捷键：Ctrl+O 打开，Ctrl+S 保存项目，Ctrl+Shift+S 导出，Ctrl+Enter 生成。

## 工程文件

| 文件 | 职责 |
| --- | --- |
| `desktop/main.cjs` | 桌面窗口、IPC 白名单、文件对话框 |
| `desktop/preload.cjs` | 受限界面通信 API |
| `desktop/bridge.cjs` | Python 子进程、请求恢复、二进制网格传输 |
| `desktop/src/main.jsx` | 工程工作台、表单、对象树、项目和诊断交互 |
| `desktop/src/Viewport.jsx` | Three.js 相机、网格、GPU 隐式混合预览、方向标 |
| `desktop/src/style.css` | 明暗主题、字体、间距、状态和窗口适配 |
| `electron_backend.py` | 复用建模核心的进程协议 |
| `launch_desktop.py` | 解释器选择、依赖安装、缓存展开和启动 |

界面设计使用 ui-ux-pro-max 的可读性、交互与性能规范；检索生成的宣传页布局没有用于工程工具。采用左右分区、系统中文字体、16px 正文、蓝色单一主色和明确的禁用/选中状态。

## G 盘运行与便携兼容布局

G 盘修复后，完整 `desktop/` 源码、锁文件、测试、构建结果和本机 `node_modules` 已同步回项目，同时恢复 `native/` 和 `scripts/`。`launch_desktop.py` 优先使用项目内 `desktop/package.json`，界面、Electron 可执行文件及 Python/libfive 后端直接从 G 盘运行。Python 和 Node.js 仍使用本机已安装的环境，不需要此前的 C 盘开发副本或 UI 缓存。

下方说明保留故障期间使用的便携回退方式。`electron-desktop.zip` 包含完整界面源码、锁文件、测试、打包脚本和已构建界面，不包含 `node_modules`。

项目没有可读取的 `desktop/package.json` 时，启动器将该压缩包按 SHA256 内容版本展开到 `%LOCALAPPDATA%/TPMSStudio/electron/<内容哈希>/desktop`，界面依赖也安装在此处。`TPMS_PROJECT_ROOT` 仍指向启动器所在项目，Python 核心和 G 盘 DLL 仍从原项目加载。此方法绕开目录创建故障，不修复 G 盘，也不隐藏对 C 盘缓存的依赖。

当前项目已使用常规 `desktop/` 源码布局。`node_modules`、`desktop/dist/` 和 `native/libfive/` 继续由 `.gitignore` 排除；运行文件已安装在 G 盘，不代表应把它们提交到 Git。原有备份和 `.refs/` 未覆盖，未自动提交或推送。

## 验证

```powershell
python -m pytest -q
cd desktop
npm ci
npm run build
npm test
npm run verify-ui
```

验证已完成：原项目 89 passed / 1 skipped；真实 Python/libfive IPC 测试覆盖生成、水密性、孔隙率、梯度 libfive、边界色、STL 长度、失败恢复、取消后重启；真实 Electron 测试覆盖暗/亮主题、1120×760 窗口、模型预览、实体组合、导出、CFD 区域/质量/低质量、JSON 保存打开和自定义公式回退。截图来自实际应用，不是静态效果图。

G 盘同步后再次以 G 盘后端和从 G 盘压缩包展开的 C 盘缓存界面运行相同 IPC / 真实 Electron 验收，通过。所有交付文件逐项进行 SHA256 同步校验。

R-057 完整同步验收于 2026-10-09 23:55:13（Asia/Shanghai）完成：5,773 个文件校验通过；原 Python 测试 89 passed / 1 skipped；从 `G:/TPMS建模设计/desktop` 运行 Electron 构建、IPC 测试和真实窗口验收全部通过，页面异常为零。当前测试与正常启动均使用 G 盘 Electron 目录和 G 盘 libfive 原生库，不使用此前的 C 盘 UI 缓存。

正式 CFD 的 COMSOL 实机导入、物理场配置、网格无关性和大模型性能基准仍沿用既有验收限制。
