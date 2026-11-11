import pytest
from fastapi.testclient import TestClient

from backend.api.main import create_app
from backend.core.config import Settings


@pytest.fixture
def client():
    # Sem Postgres/Redis configurados: os testes não dependem de infraestrutura.
    app = create_app(Settings(_env_file=None, postgres_host="", redis_host=""))
    with TestClient(app) as c:
        yield c
