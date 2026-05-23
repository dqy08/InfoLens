from typing import Dict, Iterable, Optional, Sequence, Tuple


class ModelInstance:
    """Lightweight wrapper holding a configured language model instance."""

    def __init__(self, model_cls, config):
        self.config = config
        self.lm = model_cls()


class ModelRegistry:
    """Manages lazy loading and caching of backend language models."""

    def __init__(self, available_models: Dict[str, object]):
        self._available_models = available_models
        self._projects: Dict[str, ModelInstance] = {}

    def __contains__(self, project_name: str) -> bool:
        return project_name in self._projects

    def get(self, project_name: str) -> Optional[ModelInstance]:
        return self._projects.get(project_name)

    def configs(self) -> Dict[str, object]:
        return {name: project.config for name, project in self._projects.items()}

    def available_model_names(self) -> Sequence[str]:
        return tuple(self._available_models.keys())

    def is_available(self, project_name: str) -> bool:
        return project_name in self._available_models

    def load(self, project_name: str) -> ModelInstance:
        if project_name not in self._available_models:
            raise KeyError(f"模型 '{project_name}' 未在 REGISTERED_MODELS 中注册")

        project = ModelInstance(self._available_models[project_name], project_name)
        self._projects[project_name] = project
        return project

    def ensure_loaded(self, project_name: str) -> ModelInstance:
        """Return a project instance, loading it if necessary."""
        if project_name in self._projects:
            return self._projects[project_name]
        return self.load(project_name)
    
    def unload(self, project_name: str) -> bool:
        """卸载指定模型，释放内存"""
        if project_name in self._projects:
            del self._projects[project_name]
            return True
        return False

    def ensure_any(self, candidates: Iterable[str]) -> Tuple[str, ModelInstance]:
        """Load (or reuse) the first successfully instantiated project."""
        last_error: Optional[Exception] = None
        for candidate in candidates:
            if not candidate:
                continue
            if candidate in self._projects:
                return candidate, self._projects[candidate]
            try:
                project = self.load(candidate)
                return candidate, project
            except Exception as exc:  # noqa: BLE001 - bubble up aggregated info
                last_error = exc
                continue
        if last_error:
            raise last_error
        raise ValueError("没有可用的模型！")

