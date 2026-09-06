class YAMLError(Exception):
    pass


def safe_load(text):
    result = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise YAMLError("unsupported YAML line")
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip()
        if not key:
            raise YAMLError("empty key")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key] = value
    return result
