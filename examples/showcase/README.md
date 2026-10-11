# 可编辑复杂建模示例

本目录提供现有 TPMS、基本体、布尔和参数节点组合而成的示例项目。

| 项目 | 几何节点 / 参数 | 内容 |
| --- | --- | --- |
| [Gyroid 双法兰](gyroid-flanged-core.json) | 19 / 3 | 圆柱点阵芯、共享法兰、四个安装孔和轴向流道 |
| [三向开孔球壳](perforated-ring-sphere.json) | 11 / 3 | 空心球壳、赤道加强环和 XYZ 正交流道 |
| [参数化八瓣花](../parametric-flower/eight-petal-flower.json) | 25 / 4 | 椭球母体、旋转复制、花茎与叶片组合 |

![暗色工作台中实际生成的双法兰模型](../../docs/showcase-gyroid-dark.png)

在 TPMS Studio 顶部“打开”选择 JSON，再点击“生成工作流”。运行这些实体项目需要 libfive 原生库；修改节点、参数或输出精度后重新生成，再导出 STL / OBJ / PLY。

[模型画廊](../../docs/model-gallery.md) 说明节点关系、参数与查看方法，[几何验收数据](geometry-report.json) 提供实际原始 STL 回读结果。示例没有制造、打印、承载或流体求解验收，不能替代工程验证。

项目由 `scripts/create_showcase.py` 生成，可从仓库根目录运行：

```powershell
python scripts/create_showcase.py --output examples/showcase
```

该命令写入两份预置项目，保留自定义改动时请先另存。
