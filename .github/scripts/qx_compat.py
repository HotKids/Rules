"""Conservatively recognize a small, shared QX/Surge body-script subset.

This is not a general JavaScript compatibility proof. Unknown APIs, dynamic
access and completion shapes stay on the compatibility-runtime path. Source
comments/strings are never removed with a regex: mentions of non-shared APIs
may deliberately cause a conservative false negative.
"""
from __future__ import annotations

import ast
import re


_GLOBALS = {"$request", "$response", "$done"}
_DOLLAR_NAME = re.compile(r"\$[A-Za-z_$][A-Za-z_0-9$]*")
_DYNAMIC = re.compile(
    r"\b(?:eval|Function|globalThis|global|window|self|this|constructor|__proto__|"
    r"Reflect|Proxy|statusCode|sessionIndex|bodyBytes)\b"
)
_IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z_0-9$]*")
_NUMBER = re.compile(r"(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?n?)")
_OPERATORS = tuple(sorted((
    "===", "!==", ">>>", "**=", "&&=", "||=", "??=", "=>", "==", "!=",
    "&&", "||", "??", "?.", "...", "++", "--", "+=", "-=", "*=", "/=",
    "%=", "**", "<=", ">=", "<<", ">>", "&=", "|=", "^=",
), key=len, reverse=True))
_REGEX_PREFIX = {"(", "[", "{", "=", ":", ",", ";", "!", "?", "&&", "||",
                 "??", "return", "case", "=>"}
_ASSIGNMENTS = {"=", "+=", "-=", "*=", "/=", "%=", "++", "--", "&&=", "||=", "??="}


def _tokens(source):
    """Tokenize the limited lexical forms needed to inspect host API access.

    Regexes, strings and comments are consumed as complete lexical units;
    templates, escaped identifiers and unknown forms return no proof.
    """
    result, index, length = [], 0, len(source)
    while index < length:
        char = source[index]
        if char.isspace():
            index += 1
            continue
        if source.startswith("//", index):
            end = source.find("\n", index + 2)
            index = length if end < 0 else end + 1
            continue
        if source.startswith("/*", index):
            end = source.find("*/", index + 2)
            if end < 0:
                return None
            index = end + 2
            continue
        if char in "\"'":
            start, quote = index, char
            index += 1
            while index < length and source[index] != quote:
                if source[index] in "\r\n":
                    return None
                index += 2 if source[index] == "\\" else 1
            if index >= length:
                return None
            index += 1
            result.append(("string", source[start:index]))
            continue
        if char == "`" or char == "\\":
            return None
        if char == "/" and (not result or result[-1][1] in _REGEX_PREFIX):
            start, in_class = index, False
            index += 1
            while index < length:
                current = source[index]
                if current in "\r\n":
                    return None
                if current == "\\":
                    index += 2
                    continue
                if current == "[":
                    in_class = True
                elif current == "]":
                    in_class = False
                elif current == "/" and not in_class:
                    break
                index += 1
            if index >= length:
                return None
            index += 1
            while index < length and source[index] in "dgimsuvy":
                index += 1
            result.append(("regex", source[start:index]))
            continue
        match = _IDENTIFIER.match(source, index)
        if match:
            result.append(("identifier", match[0]))
            index = match.end()
            continue
        match = _NUMBER.match(source, index)
        if match:
            result.append(("number", match[0]))
            index = match.end()
            continue
        operator = next((op for op in _OPERATORS if source.startswith(op, index)), None)
        if operator:
            result.append(("punctuation", operator))
            index += len(operator)
        elif char in "()[]{}.,;:?=+-*/%!~&|^<>":
            result.append(("punctuation", char))
            index += 1
        else:
            return None
    return result


def _closing(tokens, start):
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack = []
    for index in range(start, len(tokens)):
        kind, value = tokens[index]
        if kind != "punctuation":
            continue
        if value in pairs:
            stack.append(pairs[value])
        elif value in pairs.values():
            if not stack or stack.pop() != value:
                return None
            if not stack:
                return index
    return None


def _shared_done(tokens, index):
    """Accept only a literal empty object or one literal `body` field."""
    if index + 2 >= len(tokens) or tokens[index + 1][1] != "(" or tokens[index + 2][1] != "{":
        return False
    start = index + 2
    end = _closing(tokens, start)
    if end is None or end + 1 >= len(tokens) or tokens[end + 1][1] != ")":
        return False
    inner = tokens[start + 1:end]
    if not inner:
        return True
    if len(inner) < 3 or inner[0][1] not in {"body", "'body'", '"body"'} or inner[1][1] != ":":
        return False
    stack, pairs = [], {"(": ")", "[": "]", "{": "}"}
    for offset, (kind, value) in enumerate(inner[2:], 2):
        if kind != "punctuation":
            continue
        if value == "...":
            return False
        if value in pairs:
            stack.append(pairs[value])
        elif value in pairs.values():
            if not stack or stack.pop() != value:
                return False
        elif value == "," and not stack and offset != len(inner) - 1:
            return False
    return not stack


def can_use_upstream(source: str, mode: str) -> bool:
    """True only for recognizable body scripts using shared input/output APIs.

    Header-only, echo and scheduled modes deliberately stay on the runtime path.
    No source URL, application name or script filename participates in this test.
    """
    if (not isinstance(source, str) or not source.strip() or not isinstance(mode, str)
            or mode not in {"request-body", "response-body"}):
        return False
    if set(_DOLLAR_NAME.findall(source)) - _GLOBALS or _DYNAMIC.search(source) or "`" in source:
        return False
    tokens = _tokens(source)
    if tokens is None:
        return False
    done_count = 0
    for index, (kind, value) in enumerate(tokens):
        if kind != "identifier" or value not in _GLOBALS:
            continue
        if index and tokens[index - 1][1] in {".", "?."}:
            return False
        if value == "$done":
            if not _shared_done(tokens, index):
                return False
            done_count += 1
            continue
        before = tokens[index - 1][1] if index else None
        after = tokens[index + 1][1] if index + 1 < len(tokens) else None
        prefix = index - 1
        while prefix >= 0 and tokens[prefix][1] == "(":
            prefix -= 1
        if prefix >= 0 and tokens[prefix][1] in {"++", "--", "delete"}:
            return False
        if before == "typeof" or after in {"&&", "?"}:
            continue
        if after != "." or index + 2 >= len(tokens):
            return False
        field = tokens[index + 2][1]
        allowed = {"url", "method"} if value == "$request" else set()
        if ((value == "$request" and mode == "request-body")
                or (value == "$response" and mode == "response-body")):
            allowed.add("body")
        if field not in allowed:
            return False
        suffix = index + 3
        while suffix < len(tokens) and tokens[suffix][1] == ")":
            suffix += 1
        following = tokens[suffix][1] if suffix < len(tokens) else None
        if following in _ASSIGNMENTS:
            return False
    return done_count > 0


def _literal_property(tokens):
    """Resolve literal string concatenation in a computed property only."""
    if not tokens or len(tokens) % 2 == 0:
        return None
    values = []
    for index, (kind, value) in enumerate(tokens):
        if index % 2:
            if value != "+": return None
        elif kind != "string" or len(value) > 128:
            return None
        else:
            try: decoded = ast.literal_eval(value)
            except (SyntaxError, ValueError): return None
            if not isinstance(decoded, str): return None
            values.append(decoded)
    return "".join(values)


def requires_binary_body(source: str) -> bool:
    """Detect native QX byte-body access without executing the script.

    Inspect direct/optional properties, literal computed properties, simple
    host aliases and destructuring. Other objects' bodyBytes fields, comments,
    strings do not select native binary mode. Dynamic computed host properties
    and unrecognized lexical forms with possible host byte access are rejected
    before publication instead of silently using text mode.
    """
    tokens = _tokens(source)
    if tokens is None:
        if "bodyBytes" in source and re.search(r"\$(?:request|response)\b", source):
            raise ValueError("Cannot determine QX binary body requirements")
        return False
    hosts = {"$request", "$response"}
    # A conservative alias overapproximation cannot change the script source;
    # it only requests both byte and text input views from the shared runtime.
    changed = True
    while changed:
        changed = False
        for index, (kind, value) in enumerate(tokens):
            if kind != "identifier" or value not in hosts:
                continue
            before, after = index - 1, index + 1
            while before >= 0 and tokens[before][1] == "(": before -= 1
            while after < len(tokens) and tokens[after][1] == ")": after += 1
            direct_object = after == len(tokens) or tokens[after][1] in {";", ","}
            if direct_object and before >= 1 and tokens[before][1] == "=":
                target_kind, target = tokens[before - 1]
                prior = tokens[before - 2][1] if before >= 2 else None
                if target_kind == "identifier" and prior not in {".", "?."} and target not in hosts:
                    hosts.add(target); changed = True
    for index, (kind, value) in enumerate(tokens):
        if kind != "identifier" or value not in hosts:
            continue
        if index and tokens[index - 1][1] in {".", "?."}:
            continue
        after = index + 1
        while after < len(tokens) and tokens[after][1] == ")": after += 1
        if after < len(tokens) and tokens[after][1] in {".", "?."}:
            after += 1
            if after < len(tokens) and tokens[after] == ("identifier", "bodyBytes"):
                # A plain assignment does not read the native body.
                if after + 1 == len(tokens) or tokens[after + 1][1] != "=":
                    return True
        if after < len(tokens) and tokens[after][1] == "[":
            end = _closing(tokens, after)
            if end is not None and (end + 1 == len(tokens) or tokens[end + 1][1] != "="):
                property_name = _literal_property(tokens[after + 1:end])
                if property_name is None:
                    raise ValueError("Cannot determine QX binary body requirements")
                if property_name == "bodyBytes":
                    return True
        # const {bodyBytes: bytes} = $response (including a simple host alias).
        before = index - 1
        while before >= 0 and tokens[before][1] == "(": before -= 1
        if before >= 1 and tokens[before][1] == "=" and tokens[before - 1][1] == "}":
            end = before - 1
            start = next((j for j in range(end - 1, -1, -1)
                          if tokens[j][1] == "{" and _closing(tokens, j) == end), None)
            if start is not None:
                depth, at_key = 0, True
                for key_kind, key in tokens[start + 1:end]:
                    if not depth:
                        if key == ",": at_key = True
                        elif at_key:
                            if (key_kind == "identifier" and key == "bodyBytes"
                                    or key_kind == "string" and _literal_property([(key_kind, key)]) == "bodyBytes"):
                                return True
                            at_key = False
                    if key in {"{", "[", "("}: depth += 1
                    elif key in {"}", "]", ")"}: depth -= 1
    return False
