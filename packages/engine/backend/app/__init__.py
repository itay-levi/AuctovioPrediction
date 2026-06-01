"""
MiroFish Backend - Flask应用工厂
"""

import os
import warnings

# 抑制 multiprocessing resource_tracker 的警告（来自第三方库如 transformers）
# 需要在所有其他导入之前设置
warnings.filterwarnings("ignore", message=".*resource_tracker.*")

from flask import Flask, request
from flask_cors import CORS

from .config import Config
from .utils.logger import setup_logger, get_logger


def create_app(config_class=Config):
    """Flask app factory."""
    app = Flask(__name__)
    app.config.from_object(config_class)

    # Fail closed on missing required secrets. We log the errors first so
    # operators can see the cause, then raise so the process exits.
    config_errors = config_class.validate() if hasattr(config_class, 'validate') else []
    if config_errors:
        for err in config_errors:
            print(f"[Config] FATAL: {err}", flush=True)
        # In debug we allow soft-start so a developer iterating on the config
        # doesn't get hard-crashed; production must always fail closed.
        if not (os.environ.get('FLASK_DEBUG', '').lower() == 'true'):
            raise RuntimeError(
                "Engine refused to start: missing required configuration. "
                "Set the listed environment variables before booting."
            )
    
    # 设置JSON编码：确保中文直接显示（而不是 \uXXXX 格式）
    # Flask >= 2.3 使用 app.json.ensure_ascii，旧版本使用 JSON_AS_ASCII 配置
    if hasattr(app, 'json') and hasattr(app.json, 'ensure_ascii'):
        app.json.ensure_ascii = False
    
    # 设置日志
    logger = setup_logger('mirofish')
    
    # 只在 reloader 子进程中打印启动信息（避免 debug 模式下打印两次）
    is_reloader_process = os.environ.get('WERKZEUG_RUN_MAIN') == 'true'
    debug_mode = app.config.get('DEBUG', False)
    should_log_startup = not debug_mode or is_reloader_process
    
    if should_log_startup:
        logger.info("=" * 50)
        logger.info("MiroFish Backend 启动中...")
        logger.info("=" * 50)
    
    # 启用CORS
    CORS(app, resources={r"/api/*": {"origins": "*"}})
    
    # 注册模拟进程清理函数（确保服务器关闭时终止所有模拟进程）
    from .services.simulation_runner import SimulationRunner
    SimulationRunner.register_cleanup()
    if should_log_startup:
        logger.info("已注册模拟进程清理函数")
    
    # 请求日志中间件
    @app.before_request
    def log_request():
        logger = get_logger('mirofish.request')
        logger.debug(f"请求: {request.method} {request.path}")
        if request.content_type and 'json' in request.content_type:
            logger.debug(f"请求体: {request.get_json(silent=True)}")
    
    @app.after_request
    def log_response(response):
        logger = get_logger('mirofish.request')
        logger.debug(f"响应: {response.status_code}")
        return response
    
    # 注册蓝图
    from .api import graph_bp, simulation_bp, report_bp
    app.register_blueprint(graph_bp, url_prefix='/api/graph')
    app.register_blueprint(simulation_bp, url_prefix='/api/simulation')
    app.register_blueprint(report_bp, url_prefix='/api/report')

    # MiroShop extensions
    from .miroshop.api.routes import bp as miroshop_bp
    app.register_blueprint(miroshop_bp)
    
    # Health check — reports config readiness so ops can spot misconfig fast.
    @app.route('/health')
    def health():
        validation_errors = config_class.validate() if hasattr(config_class, 'validate') else []
        return {
            'status': 'ok' if not validation_errors else 'degraded',
            'service': 'MiroFish Backend',
            'config_errors': validation_errors,
        }
    
    if should_log_startup:
        logger.info("MiroFish Backend 启动完成")
    
    return app

