# Electron 界面开发与运行

更新时间：2026-10-10 12:11:35（Asia/Shanghai）。R-063 将节点工作区整理为步骤列表与选中属性编辑；早期更新按开发日志保留。

## 当前界面

顶部“节点建模”工作区采用左侧“建模步骤 / 设计参数 / 输出设置”、中央模型预览、右侧“节点属性 / 模型信息”。选中步骤或参数时只显示它的编辑表单，输入依赖以对象名称展示；输出名称、自动更新和生成固定在左下方。点击“预览此步骤”切换到中间实体统计，导出保持最终输出。操作见 [节点建模文档](node-modeling.md)。

![节点步骤列表与右侧属性](electron-workflow-steps-dark.png)

![Electron 工程工作台：TPMS 建模](electron-tpms-dark.png)

顶部切换“TPMS 建模 / 实体组合 / 节点建模”，并提供打开、保存项目和导出。左侧参数栏独立滚动，底部生成按钮固定；中间视口支持旋转、平移、缩放、轴向视角与右下角 XYZ 方向标；右侧“模型信息”对应成功生成的完整网格。点击右上角太阳/月亮按钮切换整套主题。

| 实机截图 | 操作重点 |
| --- | --- |
| [亮色主题](electron-tpms-light.png) | 浅色工作台与深色模型保持对比 |
| [结构参数](electron-structure.png) | 壁厚、孔隙率、梯度与向下滚动后的生成精度 |
| [顶部导出](electron-export.png) | 质量/面数下拉、表面导出与 COMSOL 体网格 |
| [实体组合](electron-solid.png) | 圆柱 TPMS 减流道对象树，属性与组合编辑见左侧下方 |
| [仿真区域](electron-cfd.png) | CFD 参数与入口/出口/壁面图例 |
| [网格质量](electron-quality.png) | 实际体网格统计、直方图与低质量数量 |

界面截图展示实际运行的工作台。CFD 图展示入口、出口和壁面分组，质量报告来自实际体网格计算；示例仅用于操作说明，正式仿真仍需网格收敛验证。完整逐项说明见 [README](../README.md#新界面操作说明)、[实体组合](solid-modeling.md) 与 [libfive](libfive.md)。

## 运行

安装 Python、Node.js 和项目依赖后，双击项目根目录 `启动Electron.cmd` / `run_tpms.bat`，或者执行：

```powershell
python launch_desktop.py
```

`launch_desktop.py` 位于项目根目录。可在 VS Code 终端执行；Code Runner 在应用关闭前一直处于运行状态，再次点击运行可能显示 `Code is already running!`。

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

Three.js 只处理视图。完整网格按 float32 顶点 + uint32 索引的二进制文件传入 Electron，避免百万级 JSON 数组。传输文件位于程序创建的独立临时目录，读取后删除；关闭程序清理临时数据。正式导出由原生文件对话框确定目标，采用临时文件完成后替换的方式保留已有文件。

渲染进程关闭 Node 集成，启用 contextIsolation、sandbox 和 CSP；阻止新窗口及外部导航，不开放任意 shell 命令或任意文件系统 API。Python 的数学公式仍由现有安全解析器执行。

生成、导出、CFD 分析在独立 Python 进程串行运行。取消直接终止计算进程，后续启动新进程，必须重新生成模型。CFD 中的原多进程分域加速暂时关闭，减少桌面进程退出后残留子进程的风险；现有 Gmsh 计算仍保留。

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
| `desktop/src/NodeWorkflow.jsx` / `node_graph.mjs` | 步骤列表、选中节点属性、输入引用、拓扑排序、共享参数绑定和输出编辑 |
| `parametric.py` | 安全数值表达式和共享参数验证 |
| `desktop/src/ValueBlocks.jsx` / `workflow_values.py` | 数值、公式、向量参数块与类型化引用解析 |
| `workflow_engine.py` | 跨次数学场复用、有界网格 LRU 与逐节点计算进度 |
| `desktop/src/Viewport.jsx` | Three.js 相机、网格、GPU 隐式混合预览、方向标 |
| `desktop/src/style.css` | 明暗主题、字体、间距、状态和窗口适配 |
| `electron_backend.py` | 复用建模核心的进程协议 |
| `launch_desktop.py` | 解释器选择、依赖安装、缓存展开和启动 |

界面采用系统中文字体、16px 正文和明确的禁用/选中状态。节点属性只展示当前选中项，长内容独立滚动。

## 源码与分发

常规运行使用项目内的 `desktop/`。兼容压缩包 `electron-desktop.zip` 包含界面源码、锁文件、测试和构建结果，不包含 `node_modules`。当源码目录不可用时，启动器按压缩包内容哈希展开界面并安装依赖；建模后端仍使用项目源码。

`node_modules`、`desktop/dist/` 和 `native/libfive/` 二进制构建产物不纳入 Git。完整安装包尚未提供，Python、Node.js 和原生库需要单独配置。

## 验证

```powershell
python -m pytest -q
cd desktop
npm ci
npm run build
npm test
npm run verify-ui
npm run verify-nodes
npm run verify-node-optimization
npm run verify-workflow-layout
```

已记录的验收包括 Python 130 项通过、1 项跳过，JavaScript 4 项通过，以及生产构建和真实 Electron 窗口验收。窗口验收覆盖明暗主题、1120×760 布局、节点属性、类型化参数、循环与删除保护、保存恢复、撤销重做、自动更新错误恢复、中间预览与最终 STL 隔离、TPMS 与实体组合、CFD 边界和质量报告。

截图来自实际应用。COMSOL 导入、物理场配置、网格无关性和大模型性能基准仍需独立验收。
