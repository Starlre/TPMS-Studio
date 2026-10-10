"""Typed number/vector/formula blocks, resolved without executing user code."""
from __future__ import annotations

import ast
import copy
from parametric import FUNCTIONS, evaluate_expression, validate_parameters


def resolve_values(parameters: dict, blocks: list) -> tuple[dict, dict]:
    values = validate_parameters(parameters)
    if not isinstance(blocks, list) or len(blocks) > 32:
        raise ValueError("最多支持 32 个参数节点")
    identifiers, symbols, owners = {}, {}, {}
    for raw in blocks:
        if not isinstance(raw, dict) or raw.get('kind') not in {'number', 'formula', 'vector'}:
            raise ValueError("参数节点类型无效")
        identifier, symbol = raw.get('id'), raw.get('symbol')
        if not isinstance(identifier, str) or not identifier or identifier in identifiers:
            raise ValueError("参数节点 ID 无效或重复")
        if not isinstance(raw.get('name'), str) or not raw['name'].strip():
            raise ValueError("参数节点缺少名称")
        validate_parameters({symbol: 0})
        if symbol in symbols:
            raise ValueError("参数节点符号重复")
        identifiers[identifier], symbols[symbol] = raw, raw
        exported = [symbol] if raw['kind'] != 'vector' else [f'{symbol}_{axis}' for axis in 'xyz']
        for name in [symbol, *exported]:
            if name in values or (name in owners and owners[name] != identifier):
                raise ValueError(f"参数符号冲突：{name}")
            owners[name] = identifier
    visiting, outputs = set(), {}

    def numeric(raw):
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            return validate_parameters({'value': raw})['value']
        if not isinstance(raw, str):
            raise ValueError("数值输入必须为数字或算术表达式")
        if not raw.strip() or len(raw) > 256:
            raise ValueError("参数表达式必须为 1–256 个字符")
        try:
            tree = ast.parse(raw, mode='eval')
        except (SyntaxError, RecursionError) as exc:
            raise ValueError("参数表达式语法无效") from exc
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id not in {*FUNCTIONS, 'pi'} and node.id in owners:
                owner = identifiers[owners[node.id]]
                if owner['kind'] == 'vector' and node.id == owner['symbol']:
                    raise ValueError(f"{node.id} 是向量，请使用 {node.id}_x / _y / _z 数值分量")
                visit(owner['id'])
        return evaluate_expression(raw, values)

    def visit(identifier):
        if identifier in outputs:
            return outputs[identifier]
        raw = identifiers[identifier]
        if identifier in visiting:
            raise ValueError(f"参数节点 {raw['name']} 存在循环引用")
        visiting.add(identifier)
        try:
            if raw['kind'] == 'vector':
                components = raw.get('components')
                if not isinstance(components, list) or len(components) != 3:
                    raise ValueError("向量需要 XYZ 三个数值或表达式")
                value = [numeric(component) for component in components]
                values.update({f"{raw['symbol']}_{axis}": value[i] for i, axis in enumerate('xyz')})
            else:
                if raw['kind'] == 'number' and (isinstance(raw.get('value'), bool) or not isinstance(raw.get('value'), (int, float))):
                    raise ValueError("数值节点需要一个有限数字")
                value = numeric(raw.get('value') if raw['kind'] == 'number' else raw.get('expression'))
                values[raw['symbol']] = value
            outputs[identifier] = {'type': 'vector' if raw['kind'] == 'vector' else 'number', 'value': value, 'symbol': raw['symbol']}
            return outputs[identifier]
        except ValueError as exc:
            raise ValueError(f"参数节点 {raw['name']}：{exc}") from exc
        finally:
            visiting.discard(identifier)

    for identifier in identifiers:
        visit(identifier)
    return values, outputs


def copy_value_nodes(blocks: list) -> list:
    return copy.deepcopy(blocks)
