"""Bounded arithmetic for reusable workflow parameters; never executes Python code."""
from __future__ import annotations

import ast
import math
import re

FUNCTIONS = {"abs": abs, "min": min, "max": max, "sqrt": math.sqrt}
TPMS_FIELDS = {"size_x", "size_y", "size_z", "cells_x", "cells_y", "cells_z",
               "thickness", "iso_level", "samples_per_cell", "target_porosity",
               "gradient_thickness_start", "gradient_thickness_end"}


def validate_parameters(values: dict) -> dict[str, float]:
    if not isinstance(values, dict) or len(values) > 32:
        raise ValueError("共享参数最多 32 个，必须使用名称和值")
    result = {}
    for name, value in values.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]{0,31}", name) or name in {*FUNCTIONS, "pi"}:
            raise ValueError("参数名须为英文标识符，不能使用 pi/abs/min/max/sqrt")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1_000_000:
            raise ValueError(f"参数 {name} 必须是绝对值不超过 1000000 的有限数值")
        result[name] = float(value)
    return result


def evaluate_expression(expression: str, values: dict[str, float]) -> float:
    if not isinstance(expression, str) or not expression.strip() or len(expression) > 256:
        raise ValueError("参数表达式必须为 1–256 个字符")
    try:
        tree = ast.parse(expression, mode="eval")
        if sum(1 for _ in ast.walk(tree)) > 64:
            raise ValueError("参数表达式过于复杂")

        def checked(value):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1_000_000:
                raise ValueError("表达式结果必须为绝对值不超过 1000000 的有限实数")
            return float(value)

        def visit(node):
            if isinstance(node, ast.Constant):
                return checked(node.value)
            if isinstance(node, ast.Name):
                if node.id == "pi":
                    return math.pi
                if node.id not in values:
                    raise ValueError(f"未定义共享参数：{node.id}")
                return checked(values[node.id])
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                value = visit(node.operand)
                return value if isinstance(node.op, ast.UAdd) else -value
            if isinstance(node, ast.BinOp):
                a, b = visit(node.left), visit(node.right)
                if isinstance(node.op, ast.Add): value = a + b
                elif isinstance(node.op, ast.Sub): value = a - b
                elif isinstance(node.op, ast.Mult): value = a * b
                elif isinstance(node.op, ast.Div): value = a / b
                elif isinstance(node.op, ast.Pow) and abs(b) <= 8: value = a ** b
                else: raise ValueError("仅支持 + - * / 和绝对值不超过 8 的指数")
                return checked(value)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS and not node.keywords:
                args = [visit(arg) for arg in node.args]
                if (node.func.id in {"abs", "sqrt"} and len(args) != 1) or (node.func.id in {"min", "max"} and not 2 <= len(args) <= 8):
                    raise ValueError("函数参数数量无效")
                return checked(FUNCTIONS[node.func.id](*args))
            raise ValueError("表达式只支持共享参数和安全算术，不支持属性、索引或代码")

        return visit(tree.body)
    except (SyntaxError, ZeroDivisionError, OverflowError, TypeError, RecursionError) as exc:
        raise ValueError(f"参数表达式无效：{exc}") from exc
