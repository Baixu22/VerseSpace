"""模型产物的独立检查：加载 validators.py，跑固定用例，输出 JSON。

用法：python live-moyu-check.py <validators.py 路径>
输出：{total, passed, failures:[{name, input, expected, actual}]}
退出码：全部通过 0，否则 1。只依赖标准库。

「expected」是布尔（是否通过校验），不是期望消息——消息内容只要求
「ok=True 时必须为空串；ok=False 时必须是非空中文」这条形状契约。
"""

import importlib.util
import json
import sys

# (用例名, 函数名, 入参, 期望 ok 布尔)
CASES = [
    ("用户名下界", "validate_username", "ab", True),
    ("用户名过短", "validate_username", "a", False),
    ("用户名首尾空白", "validate_username", " 张三 ", False),
    ("用户名上界内", "validate_username", "u" * 50, True),
    ("用户名超上界", "validate_username", "u" * 51, False),
    ("用户名控制字符", "validate_username", "ab\x0bx", False),
    ("用户名中间空格合法", "validate_username", "张 三", True),
    ("邮箱常规", "validate_email", "user@example.com", True),
    ("邮箱首尾空白剔除", "validate_email", "  user@example.com  ", True),
    ("邮箱缺域名段", "validate_email", "a@b", False),
    ("邮箱内部空格", "validate_email", "us er@example.com", False),
    ("邮箱双点", "validate_email", "user@example..com", False),
    ("邮箱 local 点开头", "validate_email", ".user@example.com", False),
    ("邮箱 local 点结尾", "validate_email", "user.@example.com", False),
    ("邮箱单段域名", "validate_email", "user@localhost", False),
    ("邮箱域名连字符开头", "validate_email", "user@-x.com", False),
    ("邮箱非 ASCII", "validate_email", "用户@example.com", False),
    ("手机号 None 可选", "validate_phone", None, True),
    ("手机号常规", "validate_phone", "13812345678", True),
    ("手机号空格分隔", "validate_phone", "138 1234 5678", True),
    ("手机号短横线分隔", "validate_phone", "138-1234-5678", True),
    ("手机号号段不对", "validate_phone", "12812345678", False),
    ("手机号位数不足", "validate_phone", "1381234567", False),
    ("手机号位数超", "validate_phone", "138123456789", False),
    ("手机号纯字母", "validate_phone", "abcdefghijk", False),
    ("手机号带加号", "validate_phone", "+8613812345678", False),
    ("用户名类型错", "validate_username", 123, False),
    ("邮箱类型错", "validate_email", None, False),
    ("手机号类型错", "validate_phone", 13812345678, False),
]


def load_module(path):
    spec = importlib.util.spec_from_file_location("validators_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_cases(module):
    failures = []
    for name, fn_name, argument, expected in CASES:
        fn = getattr(module, fn_name, None)
        if fn is None or not callable(fn):
            failures.append(
                {
                    "name": name,
                    "input": repr(argument),
                    "expected": expected,
                    "actual": "缺少函数 " + fn_name,
                }
            )
            continue
        try:
            ok, message = fn(argument)
            shape_bad = not (
                isinstance(ok, bool)
                and isinstance(message, str)
                and (message == "" if ok else len(message.strip()) > 0)
            )
            actual = "形状不合规" if shape_bad else ok
        except Exception:  # noqa: BLE001 - 任何异常都记为该用例失败
            actual = "抛出异常"
        if actual is not expected:
            failures.append(
                {
                    "name": name,
                    "input": repr(argument),
                    "expected": expected,
                    "actual": actual,
                }
            )
    total = len(CASES)
    return {
        "total": total,
        "passed": total - len(failures),
        "failures": failures,
    }


if __name__ == "__main__":
    try:
        target = sys.argv[1]
    except IndexError:
        print(json.dumps({"error": "缺少 validators.py 路径"}, ensure_ascii=False))
        sys.exit(2)
    try:
        module = load_module(target)
        result = run_cases(module)
    except Exception as error:  # noqa: BLE001 - 模块坏掉本身就是一次失败
        result = {
            "total": len(CASES),
            "passed": 0,
            "failures": [
                {"name": "模块加载", "input": target, "expected": None, "actual": type(error).__name__}
            ],
        }
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["passed"] == result["total"] else 1)
