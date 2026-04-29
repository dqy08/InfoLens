REGISTERED_MODELS = {}


def register_model(name):
    """
    注册模型类的装饰器
    
    自动将注册的模型名保存到类属性 _registered_model_name 中，
    避免在子类初始化时重复指定模型名
    """
    def decorator(cls):
        REGISTERED_MODELS[name] = cls
        # 将注册的模型名保存到类属性中
        cls._registered_model_name = name
        return cls
    return decorator
