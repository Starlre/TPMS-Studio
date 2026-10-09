# TPMS Studio 开发文档

> 用途：持续记录需求、实现、验证结果、技术决策和已知限制。<br>
> 创建日期：2026-09-17<br>
> 项目目录：`G:/TPMS建模设计`

## 1. 产品目标

TPMS Studio 是本地运行的 TPMS 参数化建模工具。用户在 GUI 中输入曲面类型、外形尺寸、周期数、壁厚或等值面偏移、精度和目标孔隙率，软件生成 TPMS 封闭模型，并支持：

- OpenGL GPU 三维预览。
- STL、OBJ 和 PLY 表面网格导出。
- TPMS 孔隙流体域提取。
- Gmsh 四面体体网格划分。
- COMSOL 可导入的 NASTRAN BDF 和 Gmsh MSH 导出。

## 2. 技术架构

| 文件 | 职责 | 主要技术 |
| --- | --- | --- |
| `app.py` | GUI、后台任务、OpenGL 预览、导出交互 | PyQt5、OpenGL 3.3 |
| `tpms_core.py` | 隐式场、材料域/流体域、Marching Cubes、孔隙率求解、碎片清理 | NumPy、scikit-image、trimesh |
| `gpu_preview.py` | GPU 隐式场判定、uniform 构建、GLSL 射线步进源码 | PyQt5 OpenGL 3.3, GLSL |
| `comsol_mesh.py` | 连通流体域分解、四面体划分、边界分组、BDF/MSH/JSON 导出 | Gmsh、meshio |
| `test_tpms_core.py` | 封闭性、孔隙率、流体域回归测试 | pytest |
| `test_comsol_mesh.py` | 真实体网格生成和格式回读测试 | pytest、Gmsh、meshio |
| `test_gpu_preview.py` | GPU 预览状态与 fallback 回归测试 | pytest, PyQt5 offscreen |

### 2.1 建模约定

- 支持 `Gyroid`、`Diamond`、`Primitive`、`I-WP` 和 `Neovius`。
- 片层模式生成 TPMS 中性面的双侧壁厚。
- 实体模式保留隐式函数的一侧，由等值面偏移控制材料体积。
- `material_scalar <= 0` 表示材料域。
- 流体域是外形包围盒内的材料补集，并在外边界封闭。

### 2.2 COMSOL 分组约定

| 名称 | 属性号 | 规则 |
| --- | ---: | --- |
| `inlet` | 101 | 所选流向的负方向外边界 |
| `outlet` | 102 | 所选流向的正方向外边界 |
| `walls` | 103 | TPMS 内壁和其他外边界 |
| `fluid` | 201 | 所有四面体流体单元 |

## 3. 需求与更新台账

以下按本轮开发对话的需求顺序记录。早期没有独立版本标签，因此不虚构提交号。

| ID | 需求/问题 | 更新情况 | 状态 |
| --- | --- | --- | --- |
| R-001 | 做 TPMS 建模 GUI，输入参数输出模型 | 建立 PyQt5 GUI，支持曲面、模式、尺寸、周期、壁厚、偏移和精度；支持 STL/OBJ/PLY | 已完成 |
| R-002 | 文件夹改名为“TPMS建模设计” | 项目当前位于 `G:/TPMS建模设计` | 已完成 |
| R-003 | 拖动预览非常卡 | 重做为 OpenGL 3.3 保留式 GPU 视口，拖动只更新相机矩阵 | 已完成 |
| R-004 | 预览像一块绿色，看不清几何 | 增加法线、主光、补光、边缘光和曲面层次 | 已完成 |
| R-005 | 为什么不能像 nTop 一样流畅 | 说明 nTop 在隐式内核、GPU/并行计算、自适应预览和缓存方面的优势 | 技术说明 |
| R-006 | 重做 | 将建模与显示解耦：后台生成完整网格，GPU 显示，导出保留高精度 | 已完成 |
| R-007 | 运行软件，并授权执行本地操作 | 提供 `run_tpms.bat`，启动 GUI 验证 | 已完成 |
| R-008 | 模型还是粗糙，提高模型精度 | 改用连续隐式距离近似场上的 Marching Cubes；默认每周期 64 点，GUI 范围 16–96 | 已完成 |
| R-009 | 增加暗背景和亮背景切换 | 工具栏增加“亮色背景”切换动作 | 已完成 |
| R-010 | 亮背景时模型和背景区分不明显 | 亮色模式使用更深模型配色，增加背面扩张轮廓 | 已完成 |
| R-011 | 模型有游离于主体的单个像素群，询问是否要清理 | 判定为临界采样/裁剪形成的小连通分量，建议仅清理真正微小的碎片 | 方案确认 |
| R-012 | 清理孤立小碎片 | 增加 `remove_tiny_components()`，同时按面数占比和体积占比判定，避免误删合法流道 | 已完成 |
| R-013 | nTop 最大的优势是什么 | 说明隐式建模核心对超复杂 TPMS/点阵/场驱动几何的优势 | 技术说明 |
| R-014 | B-Rep 模型是什么 | 说明顶点-边-面-拓扑的边界表示，以及其与隐式建模/网格的差异 | 技术说明 |
| R-015 | 软件能否控制孔隙率 | 确认可通过壁厚或等值面控制，设计目标孔隙率求解方案 | 方案确认 |
| R-016 | 增加目标孔隙率功能 | 片层模式反求壁厚，实体模式反求等值面偏移；界面显示实际孔隙率和误差 | 已完成 |
| R-017 | 直接划分体网格，导出后用于仿真 | 生成材料补集形成的封闭流体域，对每个连通域独立四面体化后合并 | 已完成 |
| R-018 | COMSOL 流体仿真 | GUI 增加流向、四面体尺寸、流体表面精度；后台导出 BDF/MSH/JSON 及 101/102/103/201 分组 | 导出完成，待 COMSOL 实机验证 |
| R-019 | 写开发文档，记录每次需求和更新 | 新增 `DEVELOPMENT_LOG.md`，包含需求台账、决策、验证、限制和记录模板 | 已完成 |
| R-020 | 为项目配置 Git | 确认 `main` 分支，新增 `.gitignore` 和 `.gitattributes`，排除 Python 缓存、测试临时目录和生成网格；配置仓库本地提交者身份并创建首次提交 | 已完成 |
| R-021 | 配置 GitHub 远程仓库 | 绑定公开仓库 `https://github.com/Starlre/TPMS-Studio.git`，将本地 `main` 设为跟踪分支并推送项目 | 已完成 |
| R-022 | 增加优先级 1 CFD 网格功能 | 增加真实棱柱边界层、首层高度/层数/增长率、入出口局部加密、曲率自适应、缩放雅可比直方图、最小体积/最大边长比和低质量单元定位 | 已完成 |
| R-023 | 更新 README 并同步本地与 GitHub | 重构项目首页文档，增加界面截图、快速开始、建模流程、CFD 参数、输出文件、质量检查和已知限制说明 | 已完成 |
| R-024 | 更新 README 界面图片与核心功能介绍 | 使用当前版本重新生成建模和 CFD 参数界面截图，将核心能力整理为模块化功能说明并同步 GitHub | 已完成 |
| R-025 | 优先级 2：仿真区域可视化 | 模型生成后即可点击“仿真区域”，后台生成流体边界并按入口、出口和壁面着色显示图例；与低质量单元定位互斥 | 已完成 |
| R-026 | 支持公式组合 | 增加安全隐式公式解析器、自定义公式建模类型，以及 `min/max` 并集/交集/差集组合；保留现有 TPMS 别名和网格导出链路 | 已完成 |
| R-027 | 自定义公式时隐藏 TPMS 参数区 | 选择“自定义公式”后隐藏周期数量控件，保留尺寸、结构模式、壁厚/等值面偏移、精度和孔隙率等通用参数；切回内置 TPMS 自动恢复 | 已完成 |
| R-028 | 网格质量按钮无法点击 | 模型生成后启用“网格质量”；首次点击在临时目录后台生成 CFD 质量数据，完成后自动打开报告；正式导出流程保持不变 | 已完成 |
| R-029 | 更新 Markdown 文档和界面截图 | README、CHANGELOG、DEVELOPMENT_LOG 同步按需网格质量流程和当前界面说明；重新生成建模与 CFD 参数截图并替换旧图片 | 已完成 |
| R-030 | 界面预览介绍不够详细 | README 增加界面区域职责表、工具栏诊断按钮状态、CFD 参数说明和典型建模流程；截图继续使用当前版本界面 | 已完成 |
| R-031 | 使用 ui-ux-pro-max 重做参数界面 | 参数控制从左侧移到顶部，按几何定义、结构与孔隙率、CFD 网格分组；生成按钮固定右上，统计条和 OpenGL 视口改为全宽；更新当前界面截图 | 已完成 |
| R-032 | 顶部区域字体太小 | 顶部工作区基础字号由 12 px 提升到 14 px，并同步放大工具栏、页签、分组标题、输入控件、主按钮和统计信息 | 已完成 |
| R-033 | 顶部界面仍显小且不好看 | 使用 16 px 字号体系重做顶部视觉层级；采用高对比工具栏、全宽任务页签、紧凑对齐的参数组和更明确的主操作按钮 | 已完成 |
| R-034 | 将参数修改界面从顶部改回左侧 | 使用可调宽度左右分割布局；几何、结构和 CFD 参数在左栏分页并独立滚动，生成按钮固定底部，右侧保留统计与 OpenGL 视口 | 已完成 |
| R-035 | 网格质量分析失败，提示 signal only works in main thread | 将 Gmsh 初始化/释放放到 Qt 主线程，后台线程仅执行 Gmsh 网格计算；缺少 Gmsh 或初始化失败时提前给出明确提示 | 已完成 |
| R-036 | CFD 体网格划分耗时久，几分钟未完成 | 增加架构档加速：`_cached_fluid_domain` LRU 缓存流体域、`_configure_gmsh_threads` 多线程、`ProcessPoolExecutor` 隔离并行（`total_tris>8000`，`TPMS_DISABLE_PARALLEL` 回退），`30mm-2cells` 实测 `18.8s->16.1s` | 已完成 |
| R-037 | 优化界面 UI，视觉现代化 | 重构 `app.py:72` `STYLE` 为 `Slate/Teal` 系统：`#f1f5f9/#0f172a/#0f766e`、`8-12px` 圆角、胶囊页签、悬浮指标卡、`teal` 渐变主按钮、细圆角滚动条 | 已完成 |
| R-038 | 字体太小 | 基准 `15px->18px->19px`，工具栏 `14->18px`、页签 `14->18px`、分组 `14->18px`、输入 `17->18px`、生成 `15->19px`，`1440×900/1120×720` 离屏验证 | 已完成 |
| R-039 | 运行提示 Code is already running | 排查仓库无该字符串，定位为 IDE/终端防重入，说明 `QApplication` 单例与 `QThread isRunning` 静默返回机制 | 已完成 |
| R-040 | 在模型预览区增加 XYZ 三轴显示 | 视口左下角增加固定尺寸方向标；红 X、绿 Y、蓝 Z 与字母标签同时传达方向，随模型旋转但不随缩放变化，适配暗色/亮色背景 | 已完成 |
| R-041 | 更新 Markdown 文档图片并推送 GitHub | 使用当前版本重新生成 `1520×960` 建模和 CFD 仿真区域截图，两张图均展示 XYZ 方向标；README 补充方向标功能说明 | 已完成 |
| R-042 | 在 GitHub 主页放置可交互的 `gyroid_tpms.stl` 三维模型 | 新增 `docs/` GitHub Pages 查看器、页面实拍封面和 Pages Actions 部署工作流；README 图片链接到在线预览 | 已完成 |
| R-043 | 网页模型右下角显示 XYZ 方向标 | 用固定 Canvas 方向标替换随模型缩放的 `AxesHelper`，显示带字母的 X/Y/Z 彩色箭头，随相机旋转更新，移动端避让模型信息面板 | 已完成 |
| R-044 | GPU 隐式曲面预览（Ray Marching） | `gpu_preview.py:12` 新增 `can_use_gpu_preview()`/`surface_index()` 与 330 core GLSL（射线-包围盒求交 + 解析梯度 + 中心差分法线 + 梯度壁厚）；`app.py:468` 重构 `OpenGLMeshView` 为双管线：网格管线保留，新增隐式管线（全屏 quad、uniform 传参、拖动 48 步/静止 112 步、尺寸归一化、Shift+拖动平移）；`MainWindow.generate/_generation_finished` 先刷 GPU 再后台 CPU 网格，诊断视图强制网格回退；自定义公式/编译失败自动回退 | 已完成 |
| R-045 | 导出精度/面数分级 | 新增导出质量下拉（原始/高~70%/中~40%/低~20%）+ 目标面数 SpinBox，原始默认不改变行为；`tpms_core:prepare_export_mesh` 按面数校验、优先 quadric、回退聚类/原始；`app:export_current` 显示格式/面数/大小，回退提示；`test_export_quality` 覆盖校验与回读 | 已完成 |
| R-046 | 导出质量 UI 移至顶部工具栏 | 将左侧 `QGroupBox:Export Quality` 移除，改为顶部 `QToolButton.MenuButtonPopup + QMenu`：四档质量单选（`QActionGroup`）、目标面数 `QSpinBox`（`QWidgetAction`）、状态标签；主按钮点击仍按当前选择直接导出，下拉仅改参数；默认原始禁用目标输入；保留 `tpms_core` 算法不变 | 已完成 |
| R-047 | 开发协作约定 | 从 2026-09-19 起，用户提出的代码、界面、功能和文档更新默认通过 OpenCode 会话执行，并同步更新 DEVELOPMENT_LOG.md；保留现有日志内容，不改其他文件 | 已完成 |
| R-048 | 导出下拉深色样式与 OpenCode 额度 | 顶部 `QToolButton#exportToolButton` 追加 `::menu-button/:hover/:pressed/:open` 深色样式（`rgba(255,255,255,0.06)` + `border-left` 细分隔线，`menu-arrow 12px`），修复白色窄条；`test_export_quality::test_export_tool_button_style_has_menu_button_states` 覆盖；`Free usage exceeded` 为 OpenCode 外部额度限制，非项目代码错误 | 已完成 |
| R-049 | 开发执行方式调整 | 记录时间：2026-09-20 00:03:42（Asia/Shanghai）。从该时间起，代码、界面、功能和文档更新不再默认调用 OpenCode，由当前 Codex 会话直接执行；OpenCode 仅在用户明确要求时调用 | 已完成 |
| R-050 | 开发日志逐次更新规范 | 记录时间：2026-09-20 00:11:15（Asia/Shanghai）。要求开发文档记录每一次更新的唯一编号、精确时间、更新内容、涉及文件、验证结果和完成状态；新记录只追加，不覆盖历史记录 | 已完成 |
| R-051 | 引入 libfive | 记录时间：2026-10-09 20:33:31（Asia/Shanghai）。新增官方原生内核接入、数学表达式树、自适应表面导出、顶部内核/精度控件、构建脚本和原生验证；在 C 盘临时副本完成。G 盘 exFAT 报告 Full Repair Needed，用户决定先处理磁盘再写回项目 | 实现与验证完成，待写回原项目 |
| R-052 | 丰富可操作的建模功能 | 记录时间：2026-10-09 21:00:21（Asia/Shanghai）。新增实体与组合工作区、球/盒/圆柱/圆环/TPMS、尺寸/位置/旋转、并集/交集/差集/平滑融合、对象列表、参数项目保存/打开和三种示例。用户允许写回 G 盘，但原生 API 仍报告致命设备错误 | 功能与 C 盘验证完成，G 盘写回受阻 |
| R-053 | 实体组合入口不明显 | 记录时间：2026-10-09 21:26:11（Asia/Shanghai）。把模式下拉框改为常显双模式按钮，20 px 加粗文字、54 px 高度、深青色选中状态与功能提示；验证切换、生成、TPMS 恢复及两种窗口截图，更新 C 盘可运行版本 | 已完成 |
| R-054 | 同步 G 盘与排查写入失败 | 记录时间：2026-10-09 21:49:11（Asia/Shanghai）。先备份 G 盘项目及 Git 历史；目录创建仍失败，改用根目录便携 DLL 布局，将 libfive、实体组合、明显模式按钮、文档与图片同步回 G 盘。G 盘全量 89 passed、1 skipped，真实 Qt/OpenGL 三种示例通过 | 同步与验收完成，磁盘故障未修复 |
| R-055 | 整理 Git 更新与中文备注 | 记录时间：2026-10-09 22:03:56（Asia/Shanghai）。在“新增建模功能”分支整理 libfive、实体与布尔组合、入口按钮、便携安装、文档截图及已有管状核心改动，使用中文提交备注；排除参考仓库与本机 DLL | 已整理，随本次提交记录 |

| R-056 | 按 Electron 方案改造界面 | 记录时间：2026-10-09 23:04:24（Asia/Shanghai），G 盘验收：23:12:48。Electron/React 工程工作台、Three.js/WebGL 混合隐式预览、独立 Python/libfive 计算、CFD 诊断、快照导出、JSON 项目与明暗主题；真实窗口验收及截图；G 盘目录故障采用源码压缩包与 C 盘缓存启动 | 已实现并同步，G 盘实机验收通过 |

| R-057 | G 盘修复后同步所有更新 | 记录时间：2026-10-09 23:34:37（Asia/Shanghai），验收完成：23:55:13。同步完整 Electron 源码/依赖/构建结果、libfive 原生库/许可、开发脚本和文档；启动器使用 G 盘常规目录，不再依赖 C 盘 UI 缓存 | 已完成，G 盘实机验收通过 |

| R-058 | VS Code 批处理入口报命令碎片与乱码 | 更新时间：2026-10-10 00:01:08（Asia/Shanghai）。修正 Windows 启动脚本为 CRLF、无 BOM、ASCII 内容；`run_tpms.bat` 直接调用 Python，中文命名入口转调 ASCII 文件名；补充 Git 的 `.cmd` 换行规则，按 Code Runner 命令验证真实窗口 | 已完成 |

| R-059 | 提交 Git 更新并增加中文备注 | 更新时间：2026-10-10 00:10:33（Asia/Shanghai）。整理 R-056–R-058 的 Electron 工程工作台、完整 G 盘部署、启动脚本修复、文档截图与验证记录，提交当前“新增建模功能”分支 | 随本次本地提交记录 |

## 4. 关键更新详情

### 4.1 GPU 预览与网格精度

- 网格只上传 GPU 一次，拖动和缩放不重算几何。
- 约 65.1 万三角面的模型在当前机器上曾测得约 170 FPS。
- 完整网格用于统计和导出；仅当面数超过 150 万时才创建简化预览网格。
- 默认参数的完整模型约为 651,788 个三角面，具体数量随几何参数变化。

### 4.2 孔隙率求解

- 片层模式通过隐式面距离分布的分位数反求壁厚。
- 实体模式通过隐式场分位数反求等值面偏移。
- 默认测试参数下曾测误差约 0.11–0.25 个百分点。
- 体网格导出保留预览模型已求得的壁厚/等值面，不在另一精度下重复求解。

### 4.3 COMSOL 体网格

- 片层 TPMS 可产生两套或多套互不连通的真实流体网络，它们不属于需要删除的碎片。
- 每个封闭流体域独立进行 Gmsh HXT 四面体划分和 Netgen 优化，然后合并到统一网格。
- 导出任务在 QThread 中运行，不阻塞 GUI。
- 同时生成 `.bdf`、`.msh` 和 `_boundaries.json`。
- 12 mm 立方体、1 个 Gyroid 周期、表面精度 16、单元尺寸 2 mm 的测试样例生成 1,330 个节点、4,072 个四面体和 2 个流体域。

### 4.4 CFD 边界层与质量分析

- 边界层使用 Gmsh 法向离散挤出，生成真实 `Prism 6` / NASTRAN `CPENTA` 单元，核心域使用 `Tetrahedron 4` / `CTETRA` 填充。
- 当前对封闭流体域的全部边界挤出棱柱层，因此包含 TPMS 壁面、入口和出口。
- 参数包括首层高度、层数和增长率；若高曲率或狭窄孔道导致偏置面自交，导出会拒绝产生无效网格并提示减小参数。
- 入口和出口使用 Box 尺寸场局部加密，可设置加密距离和相对尺寸。
- 曲率自适应使用 Gmsh `MeshSizeFromCurvature`，可设置每圆周采样点数。
- 质量报告统计缩放雅可比的最小值、5% 分位、中位数、平均值、直方图，以及最小单元体积和最大边长比。
- `*_quality.vtu` 保存所有体单元的 `scaled_jacobian` 场；GUI 可切换为警示色的低质量单元定位视图。

### 4.5 仿真区域可视化

- TPMS 模型生成完成后，GUI 工具栏即可点击“仿真区域”；首次点击在后台生成流体边界，CFD 导出完成后直接复用已生成的边界预览。
- 视口按物理分组显示入口、出口和壁面，颜色分别为蓝色、橙色和绿色，并在视口上方显示图例。
- 彩色预览复用已导出的边界三角面，不重新生成 Gmsh 网格；关闭后恢复 TPMS 模型预览。
- “仿真区域”和“低质量单元”只能同时启用一个，避免不同诊断颜色互相覆盖。

### 4.6 数学公式组合

- `tpms_core.py` 增加受限 AST 解析器，不使用 Python `eval`，只允许坐标、数字、白名单数学函数和隐式组合运算。
- “自定义公式”使用模型中心为原点的毫米坐标 `x/y/z`；内置 `gyroid`、`diamond`、`primitive`、`i_wp`、`neovius` 可直接作为标量场参与组合。
- `min(A, B)` 表示隐式并集，`max(A, B)` 表示交集，`max(A, -B)` 表示差集；结果继续沿用连续场、Marching Cubes、碎片清理和表面/体网格导出流程。
- 公式计算异常、非法名称、未允许函数、复杂指数和非有限结果会在生成前拒绝。

### 4.7 网格质量按需预览

- “网格质量”不再依赖用户先选择导出路径，TPMS 模型生成完成后即可点击。
- 首次点击使用当前 TPMS 和 CFD 参数，在系统临时目录运行现有 CFD 体网格流水线，复用同一套质量统计、低质量单元和仿真区域数据。
- 质量预览期间生成、表面导出、CFD 导出和诊断切换按钮会暂时禁用，避免多个后台网格任务互相覆盖。
- 临时质量文件用于报告和定位；点击“导出 COMSOL 流体网格”仍会按用户指定路径写出正式 BDF、MSH、边界元数据和质量 VTU。

### 4.8 专业工程软件界面重构

- 采用高信息密度、低动效的工程软件布局，使用中性浅色表面、深色文字和明确的选择色，减少装饰性元素对建模任务的干扰。
- 参数控制从左侧滚动栏迁移到顶部页签式工作台，按“几何定义”“结构与孔隙率”“CFD 网格”组织，减少纵向查找和横向视口挤压。
- “生成模型”作为主操作固定在工作台右上角；模型统计条和 OpenGL 视口使用全宽布局，便于观察复杂孔道和表面细节。
- 输入控件补充清晰的焦点、悬停、按下和禁用状态；自定义公式模式继续自动隐藏不适用的周期数量参数。
- 在 `1440×900` 默认窗口和 `1120×720` 最小窗口下完成原生 Qt 布局检查，几何与 CFD 参数组均无重叠或文字截断。

### 4.9 左侧参数栏布局

- 根据使用反馈将参数控制从顶部工作台移回左侧，使用 `QSplitter` 允许在 400–540 px 范围内调整参数栏宽度。
- 左栏保留“几何定义”“结构控制”“CFD 网格”三个任务页签，每个页签使用独立 `QScrollArea`，避免整窗滚动影响模型观察。
- “生成模型”固定在参数栏底部；CFD 参数滚动时主操作仍然可见。
- 右侧继续显示模型统计条和 OpenGL 视口，建模、孔隙率、CFD 导出与诊断逻辑未改变。

### 4.10 CFD 体网格架构加速

- 流体域 `lru_cache(4)` 复用 `generate_fluid_domain`，二次导出省去一次 `Marching Cubes`（`10mm` 二次 `1.8s->1.6s`）。
- `comsol_mesh.py:224` `_configure_gmsh_threads` 尝试设置 `General/Mesh.NumThreads` 多线程。
- 多连通域 `ProcessPoolExecutor` 隔离 `Gmsh`（非线程安全），阈值 `total_tris>8000` 且 `cpu>1` 时并行，`30mm-2cells-24` 实测 `18.8s->16.1s`，小模型自动串行避免 `16s` spawn 开销；支持 `TPMS_DISABLE_PARALLEL=1` 回退。
- `QThread` 子线程 `spawn` 已验证 `30mm` 并行 `17.9s` 无 `signal only works in main thread` 退化。

### 4.11 视觉现代化与字号体系

- `app.py:72` 重构为 `Slate/Teal` 设计系统：背景 `#f1f5f9`、卡片 `#ffffff`、边框 `#e2e8f0`、文字 `#0f172a/#475569`、主色 `#0f766e`。
- 工具栏深 `slate #0f172a + 2px teal` 底线，`QToolButton 8px` 圆角半透明；页签胶囊 `8px`（选中 `teal` 实心）；`QGroupBox 10px` 悬浮卡；`teal` 渐变主按钮 `10px`；细圆角滚动条 `10px`。
- 字号两轮放大：`15px->18px->19px` 基准，工具栏 `14->18px`、页签 `14->18px`、分组 `14->18px`、输入 `17->18px`、生成 `15->19px`、状态栏 `12->15px`，`1440×900/1120×720` 离屏无截断。

### 4.12 GPU 隐式曲面预览（Ray Marching）

- **原理**：在片段着色器中对每像素发射相机射线，先与模型包围盒求交得到 `tNear/tFar`，再在 `[tNear, tFar]` 内 sphere-tracing。SDF 为 `abs(F)/|grad|-thick/2`（片层）或 `(iso-F)/|grad|`（实体），`|grad|` 为物理梯度解析解 `∂F/∂phase * 2π*cells/size`，梯度壁厚按 `thickness(u)=mix(start,end,clamp((local+size/2)/size))`，包围盒外 `max(mat,box)` 裁剪。
- **管线**：保留原有 VBO/IBO 网格管线；新增 `gpu_preview.py` 330 core 源码与全屏 quad VAO。`app.py:OpenGLMeshView` 按 `can_use_gpu_preview()` 判定：`Gyroid/Diamond/Primitive/I-WP/Neovius` 走 GPU，`Custom` 直接回退；编译/链接失败或显卡不支持也回退，不崩溃。着色参数全部 uniform 传入，不拼接用户字符串。
- **相机与交互**：`u_invViewProj = (P*V)^-1` 从 `gl_FragCoord` 重建世界射线，模型平移通过 `u_pan` 统一作用于 box 与场求值。保留 yaw/pitch/distance 旋转缩放；新增 `Shift+拖动 / 中键` 平移（`pan` 钳制在 `±2.5*model_radius`），复用同一视角矩阵，XYZ 方向标仍由旋转矩阵驱动，不受平移/缩放影响。
- **性能与质量**：拖动/平移时 `u_maxSteps=48`，静止 80ms 定时器恢复 `112` 步；`u_minStep` 与 `u_eps` 按 `max(size)*0.0006~0.0008` 归一化，避免尺寸变化导致步进异常；`u_maxDist=distance*4` 与 `rayBox` 超时保护防止卡死。片层/实体、等值面/壁厚、X/Y/Z 梯度均在 shader 分支中处理。
- **与导出一致性**：GPU 仅用于预览，STL/OBJ/PLY 导出仍走 `tpms_core.generate_tpms` 的高精度 Marching Cubes；`MainWindow` 在 `generate()` 先刷 GPU（未求解厚度亦可预览），`_generation_finished` 再用 CPU 已求解的 `result.parameters` 刷新 GPU，保证孔隙率/梯度求解后两者轮廓基本一致。诊断视图（低质量/仿真区域）强制 `gpu_force_mesh=True` 以保留顶点着色。


### 4.13 导出质量/面数分级

- `tpms_core.py` 新增 `EXPORT_QUALITY_*`（original/high/medium/low，对应 1.0/0.7/0.4/0.2）、`validate_export_target_faces`（正整数且 ≤原始）、`get_default_target_faces`、`_cluster_simplify_trimesh`（复用 `simplify_mesh_for_preview` 聚类转 Trimesh）、`simplify_mesh_for_export`（优先 `mesh.simplify_quadratic_decimation`，失败回退聚类，最终回退原始并提示，不伪造）、`prepare_export_mesh`（不改变 `result.mesh` 拷贝导出）、`export_mesh_with_quality`（统一 STL/OBJ/PLY，`fix_normals` 后导出）。
- `app.py` 在顶部工具栏 `export_tool_button:QToolButton.MenuButtonPopup` 追加下拉 `QMenu`：四档质量 `QActionGroup`（原始/高/中/低）、目标面数 `QSpinBox`（`QWidgetAction`）、状态 `QLabel`；主按钮点击直接导出，下拉仅改参数；`_create_export_quality_menu/_on_export_quality_selected/_update_export_quality_defaults/_get_export_quality_and_target` 管理状态，左侧不再占用建模区：`QComboBox` 四档 + `QSpinBox 100-5_000_000` + 信息标签；`_on_export_quality_changed`/`_update_export_quality_defaults` 按原始面数动态设范围与默认值，原始时 Spin 禁用；`_get_export_quality_and_target` + `export_current` 校验并调用 `export_mesh_with_quality`，状态栏显示 `格式 面数 大小 回退?`，回退弹 `QMessageBox`。
- 默认原始精度，完全不改变现有导出行为与 `current_result.mesh`。


### 4.14 顶部导出下拉与深色样式

- 左侧 `QGroupBox:Export Quality` 移除，不再占用建模参数区；导出质量移至顶部 `QToolButton#exportToolButton.MenuButtonPopup + QMenu`，四档质量 `QActionGroup`、目标面数 `QSpinBox`、`QLabel` 状态均置于 `QWidgetAction`，主按钮点击直接导出。
- `app.py:STYLE` 新增更具体选择器 `QToolButton#exportToolButton` 及其 `::menu-button`、`::menu-button:hover`、`:pressed`、`:open`、`::menu-arrow` 深色样式（`rgba(255,255,255,0.06/0.12)`、`#0f766e`、`border-left`），覆盖全局 `QToolButton` 白色默认，保留 32px 可点击区与箭头可见性，未改 `tpms_core` 算法。
- 测试：`test_export_quality::test_export_tool_button_style_has_menu_button_states` 校验 `STYLE` 包含 `menu-button` 状态与 `border-left`。

### 4.15 OpenCode 会话与外部额度

- 自 2026-09-19 起，代码/界面/功能/文档更新默认经 OpenCode 会话执行并同步 `DEVELOPMENT_LOG.md`（R-047）。
- 2026-09-19 出现 `Free usage exceeded` 为 OpenCode 外部服务额度限制，非项目代码错误，不影响本地 `py_compile`/`pytest`/`git` 验证。

## 5. 验证记录

### R-059：2026-10-10 00:10:33（Asia/Shanghai）本地 Git 提交

- **需求**：提交 Git 更新并增加备注。
- **范围**：Electron + React + Three.js 工程工作台及独立 Python 通信后端；完整源码、依赖锁文件、界面与后端验收脚本；libfive 构建配置和开发工具；G 盘常规部署、CRLF 启动脚本修复、Git 换行规则；README、开发日志、更新日志与实际界面截图。
- **中文备注**：`重构 Electron 工程界面，完成 G 盘同步并修复 Windows 启动`。正文记录界面/计算分层、建模与 CFD 接入、项目保存及精度导出、同步与启动修复、文档和验证结果。
- **验证**：复用 R-057 的 G 盘 89 passed / 1 skipped、Electron 构建、真实 IPC 和真实窗口验收；复用 R-058 的 6 项批处理命令验证及真实窗口启动。提交前检查差异、暂存文件列表和 whitespace。
- **排除**：`.refs/` 外部参考仓库、`node_modules/`、`desktop/dist/`、原生 DLL、Python 缓存和测试输出不进入提交；Git 持续保存源码、锁文件、构建说明及便携源码压缩包。
- **Git**：沿用“新增建模功能”分支及现有历史，新增普通本地提交；提交编号与实际提交时间以 Git 历史为准。用户本次未要求推送 GitHub。
- **状态**：本记录纳入本次本地提交，提交结果见 Git 历史。

### R-058：2026-10-10 00:01:08（Asia/Shanghai）Windows 批处理启动修复

- **需求**：VS Code Code Runner 执行 `cmd /c "g:/TPMS建模设计/run_tpms.bat"` 时出现 `'p'`、`'/d'`、`'l'` 不是命令及中文乱码，软件无法打开。
- **原因**：实际文件字节使用 LF 换行，未落盘为 Windows CRLF；`.gitattributes` 的规则不会自动修正已经存在的文件。原入口还在切换代码页后嵌套调用中文脚本路径。此前只验证 Electron / Python 启动路径，遗漏批处理真实入口。
- **修复**：`run_tpms.bat`、`启动Electron.cmd`、`run_qt.bat` 统一为 CRLF、UTF-8 无 BOM 且内容仅 ASCII。默认入口直接选择 `TPMS_PYTHON` / 本机 Anaconda / PATH 中 Python，使用带引号绝对脚本路径；中文命名入口只转调 `run_tpms.bat`，保持退出码和参数传递。只有真实失败才暂停。
- **Git 规则**：`.gitattributes` 增加 `*.cmd text eol=crlf`，与现有 `.bat` 规则一致。
- **验证**：通过解释器替身执行 3 个真实 G 盘入口 × `cmd /c` / `cmd /d /c`，6 项均通过，校验 CRLF / 无 BOM / ASCII 字节、中文路径、跨工作目录与参数传递。再次使用用户同一条 `cmd /c` 命令实际启动，TPMS Studio 窗口运行于 `G:/TPMS建模设计/desktop/node_modules/electron/dist/electron.exe`，标准错误为空。
- **范围**：只改启动脚本和换行规则，未改建模/渲染核心；无需重跑此前已通过的全量几何测试。
- **备份与同步**：原脚本保存在 `C:/Users/郭小亮/AppData/Local/Temp/tpms-launcher-fix-20261009-235826/before`；修复与开发日志同步 G 盘项目及 C 盘开发副本。
- **状态**：已修复并实际打开窗口，本次未提交或推送 Git。

### R-057：2026-10-09 23:34:37（Asia/Shanghai）修复后完整同步 G 盘

- **需求**：用户确认 G 盘已修复，要求将所有更新同步回原项目。
- **检查**：现有 G/C 两盘核心代码及根目录文档一致；G 盘缺少此前不能创建的 Electron 源码/依赖目录、libfive 原生目录和开发脚本。
- **同步**：从 C 盘验证副本补齐 `desktop/`（含源码、锁文件、测试、构建结果与本机运行依赖）、`native/`（含官方 DLL 和第三方许可）、`scripts/`、文档、截图及根目录启动/后端文件。逐文件 SHA256 校验，仅复制新增或不同内容，不删除 G 盘已有文件。
- **运行**：`launch_desktop.py` 已有本地目录优先逻辑；存在 `G:/TPMS建模设计/desktop/package.json` 后，直接使用 G 盘 Electron 和 Python/libfive。C 盘历史缓存不参与正常启动，仍保留作兼容回退。
- **保护**：同步前检查并保存 Git 分支及 HEAD，保留 `.git`、`.refs/`、已有模型和历史备份；差异文件先备份到本次临时同步目录。没有复制历史开发备份、旧测试输出或 Python 缓存。
- **文档**：README、CHANGELOG、Electron 运行说明和 libfive 安装说明更新为修复后的常规 G 盘部署；历史 R-051–R-056 的故障和缓存记录保留。
- **同步结果**：5,773 个项目与运行文件逐项 SHA256 校验，其中 172 个新增文件完成复制，5,601 个已有文件一致。一次依赖子目录复制失败后重新检查并有限重试，完整同步通过。
- **验证**：从 G 盘运行 `python -m pytest -q`：89 passed / 1 skipped；`npm run build`、`npm test` 真实 TPMS/libfive IPC、`npm run verify-ui` 真实 Electron 窗口验收全部通过，页面异常为零。窗口验收覆盖明暗主题、不同窗口尺寸、实体组合、STL、CFD 区域/质量/低质量、JSON 保存打开与公式回退；截图在 G 盘更新。
- **路径确认**：`locate_desktop` 返回 `G:/TPMS建模设计/desktop`；`library_path` 返回 `G:/TPMS建模设计/native/libfive/libfive.dll`，官方版本 `c9e9734` 可用。
- **验收时间**：2026-10-09 23:55:13（Asia/Shanghai）。本次清单与文档备份位于 `C:/Users/郭小亮/AppData/Local/Temp/tpms-g-full-sync-20261009-232902`，真实窗口证据位于 `C:/Users/郭小亮/AppData/Local/Temp/tpms-electron-ui-Tu7us9`。
- **状态**：同步与 G 盘实机验证完成。Git 仍为“新增建模功能”分支，HEAD `12f0c6f`，本次未提交或推送 Git。

### R-056：2026-10-09 23:04:24（Asia/Shanghai）Electron 工程工作台

- **需求**：用户选择之前讨论的 Electron + React/Vue + Three.js + Python/libfive 方案，实现新的桌面 UI。
- **实现**：使用 React 的左参数 / 中视口 / 右统计工程布局，顶部常显建模模式与导出下拉；统一系统中文字体和明暗主题，支持 XYZ 字母方向标、轴向视角、缩放和键盘操作。
- **建模**：复用现有五种 TPMS、公式、孔隙率、梯度、卷绕、libfive、基本体及布尔组合。增加对象复制、依赖保护删除、最终输出、JSON 保存/打开和快捷键。
- **渲染**：将原隐式 GLSL 适配至 WebGL2，由已清理网格 stencil 限定轮廓，漏采样处保留网格底图；公式/管状/实体组合/诊断回退网格。按需渲染、拖动降低像素比、显式释放资源。
- **进程**：受限 preload、Node 集成关闭、CSP、请求白名单和本机文件对话框；独立 Python JSON-lines 计算，网格二进制传输。取消终止 worker 后清空模型，避免复用过期结果。
- **仿真**：接入真实 CFD 仿真边界、MSH/BDF/边界 JSON/VTU 导出、质量直方图和低质量单元；沿用已生成快照，组合模式明确禁用 CFD。
- **文件**：`desktop/`、`electron_backend.py`、`launch_desktop.py`、`启动Electron.cmd`、`run_tpms.bat`、`run_qt.bat`、`scripts/package_electron.py`、`electron-desktop.zip`、`docs/electron.md`、`docs/electron-*.png`、README / CHANGELOG / 本日志。
- **验证**：原全量测试 89 passed / 1 skipped；IPC 实机验证 TPMS、孔隙率、梯度 libfive、水密布尔、边界色、二进制 STL、错误恢复和取消重启通过；Playwright 真实 Electron 验证两套主题、1120×760 窗口、实体组合、STL 导出、CFD 区域/体单元质量/低质量、JSON 项目、自定义公式回退通过，页面异常为零。
- **环境处理**：本终端继承 `ELECTRON_RUN_AS_NODE=1` 会把 Electron 作为 Node 执行；在应用启动子进程中清除此标记，不更改系统环境。默认 Electron 二进制下载失败，使用单次安装镜像完成。
- **存储**：G 盘新建 `desktop/` 再次失败，先在 C 盘验证后同步根目录文件 / 现有 docs 图片和界面源码压缩包。启动器可将 UI 展开到 C 盘版本缓存，并继续运行 G 盘 Python 后端；没有修复或格式化磁盘。
- **限制**：尚未生成独立安装程序；首次 npm 安装需要网络；混合预览轮廓受生成网格精度影响；原 COMSOL 实机导入限制不变，未声称达到 nTop 性能。Qt 原界面保留作兼容入口。本需求未提交或推送 Git。
- **G 盘验收时间**：2026-10-09 23:12:48（Asia/Shanghai）。根目录入口、Python 后端、界面源码压缩包、文档和四张截图均已写回并逐项 SHA256 校验。实际以 G 盘 Python/libfive 后端运行 IPC 测试通过；以从 G 盘压缩包展开的 C 盘界面启动真实 Electron，完整窗口验收通过（含 CFD 和项目保存/打开），页面异常为零。
- **备份**：本次覆盖前的 README / CHANGELOG / 开发日志 / `.gitignore` / `run_tpms.bat` 保存在 `C:/Users/郭小亮/TPMS-electron-backup-20261009-230424`；原项目历史备份继续保留。
- **状态**：功能已实现、G 盘同步与实机验收完成。G 盘存储故障仍存在。

### R-055：2026-10-09 22:03:56（Asia/Shanghai）本地 Git 更新

- **需求**：提交 Git 更新并填写备注。
- **范围**：libfive 原生内核接入，实体对象与布尔组合建模，常显模式按钮，便携 DLL 加载，开发文档和截图、第三方许可证、构建支持压缩包；包含原先未提交的 `tpms_core.py` / `comsol_mesh.py` 管状结构改动，以保留新模块依赖的参数接口。`.refs/` 参考仓库、DLL、缓存与模型输出不纳入提交。
- **备注**：`新增 libfive 实体与布尔组合建模，优化模式入口并同步 G 盘`。
- **验证**：复用 R-054 对当前代码的全量测试 `89 passed, 1 skipped` 与真实 Qt/OpenGL 三种封闭模型验收；提交前检查暂存差异与文件列表。仅新增日志记录，无额外功能修改。
- **Git 操作**：在现有“新增建模功能”分支创建本地提交，具体提交编号以 Git 历史为准；本次用户未要求推送 GitHub。
- **存储兼容处理**：首次 G 盘 `git add` 报 `unable to create temporary file: Invalid argument`，无法插入 CHANGELOG 对象，未产生提交。采用 C 盘独立暂存副本生成正常提交和 Git 对象包，再复制到 G 盘已有 `.git/objects/pack/` 并验证可读性，最后以旧 HEAD 校验更新当前分支引用及索引；避免依赖 G 盘创建新的散列对象目录，不修改 Git 配置。此方式不修复磁盘故障。
- **差异检查说明**：完整暂存检查发现两份原样分发的 GCC `COPYING.RUNTIME` 许可证末尾含空白行；保留上游许可证原文，仅在该次检查中关闭 `blank-at-eof` 规则，其他空白检查仍启用，未改变仓库配置。

### R-054：2026-10-09 21:49:11（Asia/Shanghai）G 盘同步与存储诊断

- **需求**：G 盘程序没有新功能与按钮改动，要求同步并解释写入失败原因。
- **实际诊断**：G 盘是 exFAT、未只读、约 628 GB 空闲；卷状态为 Warning / Full Repair Needed，dirty 标记存在。新建 `native/`、`scripts/` 失败，Windows 返回致命设备硬件错误；`docs/libfive-runtime/` 返回 Incorrect function。系统日志包含磁盘 2 的事件 51/153（I/O 错误/重试）及 UASPStor 129（设备重置）。现有目录中可写新文件，测试文件 SHA256 一致。不能仅凭这些事件确定是磁盘本体、USB 线、接口还是桥接器故障。
- **保护**：在 `C:/Users/郭小亮/TPMS-G-backup-20261009-214007` 备份原项目、`.git`、`.refs/` 和未提交修改；排除缓存与测试输出，robocopy 退出码 1（成功复制）。同步前确认五个待更新文件与基线一致；`tpms_core.py`、`comsol_mesh.py` 与备份哈希一致，没有覆盖已有管状建模改动。
- **实现**：增加 DLL 便携查找，优先显式环境变量、正常 native 目录，再使用项目根目录。G 盘根目录安装 libfive 与五个依赖 DLL，现有 `docs/` 保存全部第三方许可证。新增模块、测试、文档和截图同步，更新 `app.py`、`.gitignore`、README、CHANGELOG、本日志。正常布局的 `native/`、`scripts/` 文件保存在 G 盘 `libfive-build-support.zip`，可在磁盘恢复后解压；程序运行不依赖 C 盘副本。
- **验证**：逐文件 SHA256 校验；C 盘原生专项 `28 passed`。实际从 `G:/TPMS建模设计` 加载 app 与根目录 DLL，版本 `c9e9734`；全量 `89 passed, 1 skipped`（已有无显示 GPU 测试跳过），测试临时目录使用 C 盘。真实 Windows Qt/OpenGL 后台生成球体贯穿孔 37,040 面、平滑双球 27,772 面、圆柱 TPMS 流道 91,528 面，均封闭；1120×720 与 1440×900 截图确认新按钮与模型可见。`git diff --check` 通过，只有行尾转换提示。
- **状态与限制**：同步完成；未提交、推送或改变分支。磁盘的目录创建/I/O 故障仍存在，便携安装不等于磁盘修复；未执行 `chkdsk /f`、`/r` 或格式化。先保留备份、检查 USB 线/直连接口，再安排磁盘修复。

### R-053：2026-10-09 21:26:11（Asia/Shanghai）入口可发现性

- **需求/原因**：用户认为“实体与组合建模 · libfive”入口不明显，原下拉框只展示当前模式，隐藏另一个工作区。
- **实现**：左侧顶部改为原生 QTabBar 双模式入口“TPMS 建模 / 实体组合”，保持常显、等宽展开；20 px 加粗、至少 54 px 高度、边框与悬停反馈、深青色选中底白字，支持键盘切换。下方展示模式用途；libfive 内核信息留在相应建模逻辑和导出选项中。
- **指导**：使用 ui-ux-pro-max 的 Active State 指导，突出当前模式，并沿用工程软件色彩。
- **影响文件**：`app.py`、`README.md`、`CHANGELOG.md`、`docs/solid-modeling.md`、`docs/solid-modeling-ui.png`、`docs/solid-modeling-panel.png`、本日志。
- **验证**：现有模式切换/编辑/TPMS 恢复测试 `2 passed`；真实 Windows OpenGL 窗口完成球体贯穿孔、双球融合、圆柱 TPMS 流道三个示例；1120×720、1440×900 截图检查入口完整可见，无横向裁切。
- **位置/状态**：`C:/Users/郭小亮/TPMS-Studio-libfive` 已完成；G 盘原项目尚不包含实体建模版本，本次没有覆盖原项目，也没有提交或推送。

### R-052：2026-10-09 21:00:21（Asia/Shanghai）实体与组合工作区

- **需求**：用户指出仅增加导出内核无法丰富建模能力，要求提供实际可操作的新建模功能。
- **实现**：左侧工作区增加“实体与组合建模 · libfive”；基本对象球、盒、圆柱、圆环、TPMS 独立参数快照；编辑尺寸、XYZ 位置与旋转；组合并集/交集/差集 A−B/基本实体平滑融合；可继续引用组合结果、选择最终输出、复制、删除、修改名称与输入关系。
- **数据与可靠性**：有向无环对象引用，最多 64 对象；阻止循环引用、无效输入、引用对象删除、无效尺寸/精度；JSON 原子保存完整参数与关系并校验读取；生成前应用当前对象属性；后台生成使用独立快照，失败保留上次结果。
- **实际使用**：三种可直接加载示例：圆柱内 Gyroid 与贯穿流道（TPMS∩外柱−流道）、球体贯穿孔、双球平滑融合。TPMS 参数从原工作区读取，支持现有壁厚、梯度与孔隙率设置。
- **预览导出**：libfive 直接生成封闭网格，已有 OpenGL 网格视口显示最终对象；导出同一网格，不误用 TPMS 参数重生成。任意位置模型在预览中居中，导出世界坐标保持不变；显示实际面数和体积，通用组合不显示没有明确定义的相对密度/孔隙率。
- **界面验证**：使用 ui-ux-pro-max 的分组、渐进展开、内联错误及后台反馈指导；测试 1120×720、1440×900；首次发现属性区横向裁切，改为纵向 XYZ 行和可收缩控件，修复后真实截图复核。真实 Windows OpenGL 截图展示圆柱 TPMS 与流道模型，保存为 `docs/solid-modeling-ui.png`；单独面板截图 `docs/solid-modeling-panel.png`。
- **影响文件**：新增 `solid_model.py`、`solid_panel.py`、`test_solid_model.py`、`scripts/verify_solid_ui.py`、`docs/solid-modeling.md` 与两张截图；修改 `app.py`、`libfive_backend.py`、`README.md`、`CHANGELOG.md`、`docs/libfive.md`、本日志与写回说明。
- **验证**：第一轮全量 `83 passed, 1 skipped`；布局与预览修正后全量仍 `83 passed, 1 skipped`；额外增加畸形项目/坐标/TPMS 恢复验证后实体专项 `18 passed`。真实 Qt 工作线程测试：球体孔 37,040 面、融合双球 27,772 面、圆柱 TPMS 流道 91,528 面；窗口事件循环持续响应，导出可用，组合 CFD 操作禁用。原生体积对照球、盒、圆柱、圆环与布尔盒结果均通过；STL 回读封闭。
- **限制**：组合 CFD 体网格尚未实现；TPMS 场不是精确距离场，平滑融合只允许基本实体组合；管状卷绕 TPMS 不支持；薄壁/微孔仍需用户做精度收敛检查；无拖拽节点图、撤销重做、STEP/B-Rep。相对密度/孔隙率显示“—”而非错误估计。
- **安装状态**：用户表示 G 盘已处理并授权写回；再次检查仍 `Warning / Full Repair Needed`，Windows `Directory.CreateDirectory()` 抛出“设备硬件出现致命错误”。当前不覆盖原项目，保存完整实现、DLL 与验证截图在 C 盘副本，待可写后重新核验并合并。未提交/推送 Git。
- **最终复核时间**：2026-10-09 21:03:08（Asia/Shanghai）；全量 `87 passed, 1 skipped`。另存可运行交付副本到 `C:/Users/郭小亮/TPMS-Studio-libfive`，原 G 盘写回仍受阻。


### R-051：2026-10-09 20:33:31（Asia/Shanghai）libfive 接入

- **需求**：用户要求引入 libfive，允许询问接入问题。本阶段先接入可选表面导出内核。
- **实际实现**：`libfive_backend.py` 使用官方 C API、显式树/网格释放，延迟加载本机 DLL；支持五种 TPMS 的片层/实体、自定义 AST 公式（不使用 eval）、公式布尔组合与 X/Y/Z 梯度壁厚。片层梯度使用现有采样间距的中心差分；通过乘以正梯度归一化项保持材料符号和零等值面，避免区间除零。
- **导出行为**：使用已生成模型的已求解孔隙率参数，不重复求解；顶部导出下拉新增内核选择和 mm 网格尺寸，libfive 模式暂停面数简化选项；Qt 工作线程导出，显示实际面数/大小；检查封闭性、朝向、有限顶点、正体积；先写临时文件再替换，失败保留旧文件。
- **界面修复**：检查发现已有导出主按钮未连接点击事件，补上连接；后台导出期间禁用冲突操作并保留各控件原状态，任务结束后恢复；运行中阻止关闭窗口导致线程被销毁。
- **构建**：固定 libfive 官方版本 `c9e97343e0af998cd1696e85583eccba95532b96`；MSYS2 UCRT64 GCC 16.2 x64 Release，Eigen 3.4.0、libpng/zlib。MSYS2 的 Eigen 包为 5，改为单独获取兼容 Eigen 3.4 并校验 SHA256。中文临时路径导致汇编器 Illegal byte sequence，使用 ASCII 构建/临时目录。没有修改官方内核源码。
- **影响文件**：`app.py`、`libfive_backend.py`、`test_libfive_backend.py`、`native/CMakeLists.txt`、`native/MPL-2.0.txt`、`scripts/build_libfive.ps1`、`scripts/verify_libfive_ui.py`、`docs/libfive.md`、`.gitignore`、`README.md`、`CHANGELOG.md`、本文件；本机产物 `native/libfive/` 不进入 Git。
- **验证**：基线 `43 passed, 1 skipped`；接入后全量 `69 passed, 1 skipped`；新增原生/保护/界面测试 `26 passed`；最后导出相关复测 `34 passed`。唯一跳过项是已有真实 GPU 绘制测试。真实球体与球减圆柱、五种曲面两种模式、梯度三轴、孔隙率参数复用、STL/OBJ/PLY 回读均通过。
- **实际运行证据**：40 mm 两周期 Gyroid、每周期 32 点、libfive 0.5 mm：614,880 面，封闭，孔隙率约 0.81906，约 19.36 秒（单次本机测试，不作为性能保证）。Qt 真实后台导出 10 mm Gyroid：75,372 面、3.59 MB，主事件循环持续处理事件；菜单截图人工检查标签和值可读、控件完整。
- **安装验证**：随项目构建脚本成功重新构建并安装 DLL、依赖与许可证；并发测试进程加载 DLL 时 Windows 拒绝覆盖，测试退出后重试成功。文档说明安装前关闭软件。
- **环境阻碍**：G 盘为 TOSHIBA External USB 3.0、exFAT，文件系统 HealthStatus=Warning、OperationalStatus=Full Repair Needed，新建目录返回 WinError 483/1。用户明确选择“我先处理 G 盘，之后再写回原项目”。已停止写入 G 盘，保留原项目的既有管状结构修改和 `.refs/`，未提交或推送 Git。
- **完成位置**：`C:/Users/郭小亮/AppData/Local/Temp/tpms-libfive-work`；原项目 `G:/TPMS建模设计` 待磁盘恢复后重新检查差异再写回。
- **限制**：管状卷绕明确不支持；预览、COMSOL 体网格继续走原有路径；自定义公式需满足实数定义域并进行精度收敛检查；没有新增节点编辑器、基本体专用按钮或 STEP/B-Rep；壁厚仍是原有距离近似。采用 ui-ux-pro-max 的长任务反馈/主线程响应指导，新增参数沿用现有菜单。
- **状态**：实现与验证完成；安装到原 G 盘项目待用户处理磁盘。

### 2026-09-17

- Python 语法检查：`app.py`、`tpms_core.py`、`comsol_mesh.py` 通过。
- 自动化测试：`22 passed`。
- GUI 离屏初始化：通过。
- 模型生成完成后网格质量动作启用：通过离屏 GUI 状态检查。
- 界面截图：`image.png` 展示顶部几何参数工作台、全宽统计条和建模视口，`image-cfd.png` 展示顶部 CFD 网格页签，均由当前版本应用内 Qt 截图生成并检查。
- 原生 Qt 界面检查：几何定义、结构与孔隙率、CFD 网格三个顶部页签切换正常；`1120×720` 最小窗口下控件无重叠或截断。
- 大字号界面复检：顶部正文、页签和输入控件采用 16 px 字号体系；深色工具栏与三个全宽页签在 `1440×900` 和 `1120×720` 下均显示完整。
- 自定义公式界面检查：选择“自定义公式”后周期数量分组隐藏，切回内置 TPMS 后恢复。
- COMSOL 默认参数：X 流向、32 表面精度、1.5 mm 四面体尺寸。
- 小型 COMSOL 流体网格实际导出：通过。
- MSH 回读：包含 `triangle` 和 `tetra`，分组为 101/102/103/201。
- BDF 回读：包含 `CTRIA3` 和 `CTETRA`，属性号与 MSH 一致。
- 棱柱边界层实际导出：通过，BDF 回读同时包含 `CPENTA` 和 `CTETRA`。
- 质量 VTU 回读：通过，四面体和棱柱都包含 `scaled_jacobian` 单元场。

### 2026-09-18

- 左侧参数栏原生 Qt 检查：`1120×720` 下几何参数无横向滚动或文字截断，CFD 长参数在左栏内部纵向滚动。
- 交互状态检查：三个参数页签、可调分隔线、固定生成按钮和自定义公式周期分组隐藏均正常。
- Python 语法检查通过；自动化测试 `22 passed`。
- Gmsh 线程回归：主线程预初始化后，在 QThread 中完成小型 CFD 质量网格，生成 `2,926` 个体单元，无 `signal only works in main thread` 错误。

### 2026-09-18（加速与视觉）

- CFD 加速验证：`24mm-2cells-24` 流体 `106k tris`，`30mm-2cells-24` 流体 `106k tris` 并行 `16.1s` vs 串行 `18.8s`；`10mm` 小模型 `1.6s` 串行保持，阈值避免 `16s` 并行退化。
- 缓存验证：`10mm` 二次导出命中 `lru_cache` `hits=1`，`1.8s->1.6s`。
- 视觉离屏：`1440×900/1120×720` 现代 `Slate/Teal` 样式下无重叠截断，`QSS` `py_compile` 通过，`pytest 22 passed`。
- 字号复检：`19px` 基准、`18px` 页签/输入、`19px` 生成按钮在两分辨率下均完整显示。

### 2026-09-18（XYZ 方向标）

- 图形验证：暗色、亮色和改变视角后的三组截图均正确显示 XYZ 方向标，方向与模型旋转同步，字母标签无重叠。
- README 图片验证：重新生成 `1520×960` 的 `image.png` 和 `image-cfd.png`，分别展示 TPMS 建模界面与 CFD 仿真区域，XYZ 方向标均清晰可见。
- 回归验证：`python -m py_compile app.py tpms_core.py comsol_mesh.py` 通过，`python -m pytest -q` 结果为 `22 passed`。

### 2026-09-19（GitHub Pages XYZ 方向标）

- 网页验证：桌面 `1440×900` 和移动端 `390×844` 截图均正确显示右下角 XYZ 标签；移动端避让模型信息面板，三轴方向随相机姿态更新。
- 三维画布像素验证：页面加载 `642,204` 个三角面，不是空白 WebGL 画布。

### 2026-09-19（GPU 隐式预览）

- 语法检查：`python -m py_compile app.py tpms_core.py comsol_mesh.py gpu_preview.py test_gpu_preview.py test_export_quality.py` 通过。
- 自动化测试：`32 passed`（原 22 + 新 10 GPU fallback/状态测试），包含 `Gyroid/Diamond/Primitive/I-WP/Neovius` 支持、`Custom` 回退、梯度 X/Y/Z、离屏 widget 回退、拖动/平移低步数切换与背景切换。
- 离屏 GUI 验证：`offscreen` 平台下 `OpenGLMeshView` 与 `MainWindow` 创建成功；`Custom` 预览返回 `custom_formula` 回退并保持网格路径；`Gyroid` 在模拟可用 GPU 时 `is_gpu_active()==True`；`Shift+拖动` 平移产生非零 `pan`；暗/亮背景切换与 `reset_view` 清空平移均正常；`rayBoxIntersect` 与 `calcNormal` 存在性检查通过。
- 导出一致性：`generate_tpms(Gyroid)` 生成水密网格后 `export_mesh` 可回读，GPU 预览刷新不改变 `result.triangles`。
- 已知：全屏 quad 依赖 OpenGL 3.3 Core，`ctypes.windll` 仅 Windows，直接 headless CI 不实际执行 GLSL 绘制，仅通过 fallback 逻辑保证不崩溃。


### 2026-09-19（导出精度/面数）

- 语法：`python -m py_compile app.py tpms_core.py gpu_preview.py test_gpu_preview.py test_export_quality.py` 通过。
- 测试：`python -m pytest -q` 42 passed 1 skipped（原 22 + gpu 13 + export 7），`test_export_quality` 覆盖 原始不改变/目标校验/默认70/40/20%/简化或回退有效网格/多格式回读/UI 原始默认（headless skip 明确）。
- 手动：Gyroid 4288 面模型导出 原始 4288/高 3002/中 1715/低 857 面，OBJ/PLY 均可回读；目标 >原始 抛 ValueError；`fast_simplification` 缺失时回退到原始并提示，不伪造。


### 2026-09-19（导出下拉与深色样式）

- 语法：`python -m py_compile app.py` 通过；`QToolButton#exportToolButton::menu-button` 深色样式已覆盖全局白色。
- 测试：`python -m pytest -q` 43 passed, 1 skipped（`test_export_tool_button_style_has_menu_button_states` 通过）；`git diff --check` 仅 CRLF 警告。
- 外部：`Free usage exceeded` 为 OpenCode 额度限制，已在 R-048/§4.15 记录，不影响项目构建。

## 6. 技术决策

### D-001：预览和导出解耦

不通过永久降低导出精度换取交互帧率。预览由 GPU 处理，导出使用完整几何。

### D-002：使用连续隐式场

二值体素容易产生台阶感，且无法稳定表达亚体素壁厚。当前使用连续标量场直接提取零等值面。

### D-003：保留多连通流体域

不将片层 TPMS 的多个流体网络强行合并或删除。对它们分别划分，输出时使用统一的 `fluid=201` 属性号。

### D-004：当前不生成 COMSOL MPH

本机没有 COMSOL 和相应 API，因此输出通用 BDF/MSH 网格及 JSON 语义信息，不宣称已生成包含物理场的 `.mph` 工程。

### D-005：GPU 预览与 CPU 导出解耦且轮廓一致

预览阶段用 GPU 直接求值隐式场（Ray Marching），获得像素级平滑曲面；导出仍用 CPU 连续场 Marching Cubes，保证水密与布尔裁剪。两者共用同一 `TPMSParameters`（含孔隙率求解后的厚度/等值面），STL 体积与 GPU 视觉轮廓基本一致；自定义复杂公式不尝试不安全 GLSL 转译，直接回退到网格预览。

### D-006：Shader 编译与不支持回退

任何 Shader 编译/链接异常、显卡不支持 330 core、或 `Custom` 公式均捕获后 `gpu_available=False` 并回退到网格渲染，不弹未处理异常。参数经 uniform 传入，杜绝拼接用户输入。

## 7. 已知限制

- 导出简化依赖 `trimesh` 的 `quadric` 或聚类；若 `fast_simplification/open3d` 缺失，会回退到原始精度并提示，实际面数可能与目标存在偏差（聚类近似）。
- 当前输出是表面/体网格，不是 STEP/Parasolid 类 B-Rep 几何。
- 导出体网格不等于 COMSOL 仿真已配置；材料、物理场、入口、出口、壁面和求解器仍需设置。
- 当前棱柱层作用于封闭流体域全部边界；仅对 TPMS 壁面生成棱柱层需要新增共形入出口分割。
- 仿真区域可视化当前显示边界分组，不显示体单元内部切片；体单元质量仍通过质量报告、低质量定位视图和 `_quality.vtu` 检查。
- 自定义公式当前基于规则采样，尚未支持 nTop 级自适应八叉树、节点图编辑器或精确 B-Rep/STEP 输出；GPU 预览对自定义公式一律回退到网格预览（含 `min/max/sqrt` 等组合公式亦回退）。
- GPU 预览仅支持内置 `Gyroid/Diamond/Primitive/I-WP/Neovius` 的片层（含 X/Y/Z 梯度壁厚）与实体模式；Neovius 大曲率处法线中心差分可能轻微噪点，已用 `u_eps` 归一化缓解。
- GPU 预览依赖 OpenGL 3.3 Core 与可编译 GLSL；在过旧显卡、远程 headless 或驱动缺失时自动回退到网格预览，功能不丢失。
- 流体表面精度越高、周期越多、单元尺寸越小，内存和生成时间增长越快。
- 正式 CFD 必须进行网格无关性检查；最小缩放雅可比仅是质量指标之一。
- MSH/BDF 已通过本地程序回读，但尚需在安装了 COMSOL 的机器上做最终导入验证。
- GPU 射线步进最大 112 步、最小步长 0.003–0.08 mm 钳制，极端薄壁（<0.1 mm）或极大尺寸（>200 mm）可能出现轻微自相交，已通过包围盒与 `maxDist` 超时保护避免卡死。

## 8. 后续候选项

- COMSOL 实机导入与选择集合检查。
- 入口/出口位置的可视化预览。
- 仅对 TPMS 壁面生成棱柱层，入出口保持三角形边界。
- 批量参数扫描和孔隙率/压降方案管理。
- 在有 COMSOL API 或 LiveLink 的环境中评估自动创建 `.mph` 的可行性。

## 9. 后续记录模板

新需求不覆盖历史条目，在第 3 节末尾追加：

每一次更新必须记录唯一编号、更新时间（`YYYY-MM-DD HH:mm:ss`，`Asia/Shanghai`）、更新内容、涉及文件、验证结果和完成状态。

```markdown
### R-XXX：需求标题

- **日期**：YYYY-MM-DD HH:mm:ss（Asia/Shanghai）
- **需求**：用户想解决的问题。
- **问题/原因**：缺陷或技术背景。
- **实现**：实际修改的行为。
- **影响文件**：`file.py`
- **验证**：测试命令和结果。
- **已知限制**：未覆盖的情况。
- **状态**：待处理 / 进行中 / 已完成 / 部分完成。
```

## 10. 常用验证命令

```powershell
python -m py_compile app.py tpms_core.py comsol_mesh.py gpu_preview.py test_gpu_preview.py test_export_quality.py
python -m pytest -q
python app.py
```

涉及 COMSOL 体网格的修改不应只做语法检查，至少需要完成一次小型实际网格导出，并回读 MSH 和 BDF 检查四面体与属性号。
