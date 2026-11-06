from pathlib import Path

import tomllib


def test_runtime_http_clients_are_production_dependencies():
    pyproject = tomllib.loads(Path(__file__).parents[1].joinpath("pyproject.toml").read_text(encoding="utf-8"))
    dependencies = "\n".join(pyproject["project"]["dependencies"])

    for package_name in ["httpx"]:
        assert package_name in dependencies
