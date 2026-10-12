# Electron 工程工作台

TPMS Studio 的默认桌面界面使用 Electron、React 和 Three.js。界面负责交互和视图，独立 Python 计算进程复用 TPMS、libfive 和 Gmsh 内核。本文描述当前版本；原 Qt 界面保留为兼容入口。

![当前工作台：复杂 Gyroid 组合与节点卡片](showcase-gyroid-dark.png)

## 运行

安装 Python 依赖与 Node.js 22.12+（建议 24 LTS），在项目根目录运行：

```powershell
python -m pip install -r requirements.txt
python launch_desktop.py
```

Windows 可双击 `run_tpms.bat` / `启动Electron.cmd`。启动器首次安装界面依赖并构建，后续在源码变化时重新构建；首次安装需要网络。libfive 配置见 [原生内核说明](libfive.md)，没有该库时普通 TPMS 连续场建模仍可使用，实体工作区会提示依赖缺失。

旧 Qt 入口为 `python app.py` / `run_qt.bat`。当前没有包含 Python、Node.js 与原生库的独立安装包。

## 工作区与布局

| 工作区 | 顶部工具 | 左侧编辑 | 输出 |
| --- | --- | --- | --- |
| TPMS 建模 | TPMS、检查与测量、仿真与网格 | 几何、结构、CFD 参数 | TPMS 表面与流体体网格 |
| 实体建模 | 建模、操作、TPMS 节点、参数与公式、检查与测量 | 可拖动实体/参数卡片、上游引用和输出设置 | libfive 组合表面 |

中央提供旋转、右键平移、滚轮缩放和 XYZ 视角。右侧分为模型信息与剖切测量，统计对应当前查看对象。太阳/月亮按钮切换整套主题；长内容独立滚动，生成操作固定在左侧底部。

“操作”选项卡与下拉仅保留抽壳：先创建并选中距离函数基本体，再添加节点编辑壁厚与开口；布尔位于“建模”。网页同步展示这些入口，实际创建与计算使用桌面 App。

实体项目从空白卡片区开始，搜索创建后在节点内编辑。实体与参数统一排序；标题和手柄用于调整显示顺序，类型图标用于拖动引用，两者不混用。布尔 A/B 的上游可按需嵌套展开，编辑的是同一节点数据。操作见 [节点建模](node-modeling.md) 与 [实体建模](solid-modeling.md)。

## 三种实体查看状态

| 状态 | 显示内容 | 用途 | 正式导出 |
| --- | --- | --- | --- |
| 全部实体 | 各有效几何节点的独立网格 | 相对位置、相交、源实体与结果对比 | 保留已生成的最终快照 |
| 单独预览 | 一个中间节点的依赖结果 | 检查步骤、独立统计与剖切 | 保留已生成的最终快照 |
| 最终输出 | 指定输出节点的生成结果 | 检查完整布尔组合、正式导出 | 使用该生成快照 |

![多实体查看：球壳、加强环与三向贯穿孔](showcase-layout-dark.png)

布局支持半透明、稳定颜色、选中高亮、模型/标签选择和逐个显隐。编辑后 450 ms 防抖更新；视野范围增大时适配可见实体，并保留观察方向。排序、选择、显隐和透明度不改变几何。

修改尺寸或引用使最终输出待更新，正式导出等待重新生成。“生成工作流”切回最终输出。自动更新输出默认关闭，开启后停止编辑 900 ms 更新；输入错误或取消后不反复重试相同设置。显示布局并不意味着独立实体已完成并集，重叠体积也不直接相加。

## 进程与数据流

```text
React 参数、卡片与检查工具
         │ 受限 preload IPC
Electron 主进程与原生文件对话框
         ├─ 主 Python worker：最终生成、导出、CFD 与中间预览
         └─ 布局 Python worker：各几何节点独立预览
                 │
tpms_core / solid_model / libfive_backend / workflow_engine / comsol_mesh
                 │ 二进制顶点与索引
Three.js / WebGL2 模型显示
```

最终计算与布局使用独立 PythonBridge，布局不会占用主生成队列。布局逐个提取节点依赖子图，失败节点单独反馈，其余有效实体继续显示；请求防抖、串行并丢弃过期结果。基本实体可用较粗布局提取尺度，项目的最终精度不被覆盖。

顶点以 float32、索引以 uint32 二进制传输，避免大规模 JSON 网格数组。传输文件由主进程私有目录管理，读入后清理，窗口关闭结束 worker 并清理临时数据。

主工作流复用数学场与近期网格，网格 LRU 最多 8 个、数组合计 96 MiB；布局缓存最多 64 个、数组合计 64 MiB，并限制单次预览传输规模。这些预算不包含所有属性缓存和计算峰值。取消或重启 worker 清空缓存，需重新生成输出。

渲染进程关闭 Node 集成，启用 contextIsolation、sandbox 与 CSP；禁止外部导航及新窗口，IPC 不暴露任意 shell/文件系统。空间公式和数值表达式由受限 AST 解析。文件保存完成后替换目标，避免生成失败破坏原文件。

## 预览与检查

- 普通内置 TPMS 支持 WebGL2 混合隐式预览：解析数学场叠加网格底图，清理后网格轮廓限定显示范围，漏采样时保留底图。
- 自定义公式、卷绕、实体组合、仿真边界、低质量与线框采用网格显示。着色器失败回退网格。
- 按需绘制，阻尼结束后停止；拖动时降低像素比，结束后恢复；切换模型释放几何、边缘与材质资源。
- 剖切显示即时裁剪，截面求交与拾取在 Web Worker 计算；检查不改变正式导出。
- 全部实体模式不聚合重叠网格截面，切回最终输出或单独预览后检查。

![最终输出纵向剖切](showcase-gyroid-section.png)

混合隐式预览的轮廓仍受网格精度影响，软件未发布无限精度或商业软件性能等价的保证。

## 项目与导出

JSON 保存 TPMS 参数、CFD 设置、实体与参数节点、表达式、引用、输出、精度及卡片顺序。兼容旧 Qt 实体项目和旧 Electron 实体模式，打开后进入统一实体工作区；保存项目不等于保存网格，打开后重新生成。

查看显隐、透明度、展开状态、撤销历史和缓存不保存。历史最多 50 步；文本框保留自身撤销，非文本状态的 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 控制工作流。

顶部导出集中设置原始、分级质量或目标面数。普通非卷绕 TPMS 在原生库可用时还提供 libfive 重算；实体组合使用已生成 libfive 网格。CFD 输出仅对普通 TPMS 可用，详见 [CFD 网格](cfd-meshing.md)。

快捷键：Ctrl+O 打开、Ctrl+S 保存、Ctrl+Shift+S 导出、Ctrl+Enter 生成。

## 工程文件

| 文件 | 职责 |
| --- | --- |
| `desktop/main.cjs` / `preload.cjs` / `bridge.cjs` | 主窗口、受限 IPC、两个 Python worker 与二进制传输 |
| `desktop/src/main.jsx` | 工作区、参数、项目、生成与诊断 |
| `NodeWorkflow.jsx` / `CardMenu.jsx` | 卡片、上游编辑、选择与操作菜单 |
| `ValueBlocks.jsx` / `node_graph.mjs` | 参数节点、引用与依赖检查 |
| `WorkflowDrag.jsx` / `workflow_drag.mjs` | 排序、拖动引用及显示顺序无关签名 |
| `Viewport.jsx` | 三维相机、混合预览、多实体、方向标与资源释放 |
| `InspectionPanel.jsx` / `inspection.worker.js` | 剖切、截面与两点测量 |
| `electron_backend.py` | 计算协议、生成快照、布局和网格传输 |
| `workflow_engine.py` / `workflow_values.py` | 数学场与网格缓存、受限参数求值 |
| `launch_desktop.py` | 启动、界面依赖与缓存展开 |

## 验证与截图

```powershell
python -m pytest -q
cd desktop
npm ci
npm run build
npm test
npm run verify-ui
npm run verify-nodes
npm run verify-node-optimization
npm run verify-notebook-cards
npm run verify-multi-entity
npm run verify-ribbon
npm run verify-workflow-drag
npm run verify-inspection
```

从项目根目录重建画廊项目并截取实际窗口：

```powershell
python scripts/create_showcase.py --output examples/showcase
node desktop/tests/capture-showcase.cjs
```

截图脚本打开双法兰与球壳两个可编辑项目、生成最终实体、导出 STL、比较剖切前后文件，并截取四张暗色的最终输出、布局与剖切画面。截图前切换暗色并检查主题，画廊不包含花瓣图。运行需可用的 libfive 和桌面图形环境；可通过 `TPMS_PYTHON` 指定已安装依赖的解释器，`--output` 指定图片目录。输出报告包含本次临时导出位置，不作为公开文档提交。

当前 JavaScript 基础测试为 12 项；窗口验收覆盖卡片、引用排序、多实体、工作区、CFD、质量与导出隔离。历史与每次具体结果见 [开发记录](../DEVELOPMENT_LOG.md)，画廊实际几何数据见 [模型画廊](model-gallery.md)。COMSOL 实机导入、制造验证和大模型性能基准仍需独立验收。

## 分发

`desktop/` 为界面源码，`electron-desktop.zip` 包含源码、测试、锁文件与构建结果，不含 node_modules。源码目录不可用时，启动器按压缩包哈希展开界面并安装依赖，建模后端仍使用项目源码。

`node_modules`、`desktop/dist` 和原生构建二进制不纳入 Git。完整安装包尚未提供，环境与内核配置需按指南完成。
