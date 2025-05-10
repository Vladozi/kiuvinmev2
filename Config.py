import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()


class Config:
    # Flask configurations
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-key-change-in-production')
    DEBUG = False
    TESTING = False

    # Database configurations
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URI', 'sqlite:///videochat.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Flask-SocketIO configurations
    SOCKETIO_CORS_ALLOWED_ORIGINS = '*'

    # Session configurations
    SESSION_TYPE = 'filesystem'
    SESSION_PERMANENT = False
    PERMANENT_SESSION_LIFETIME = 3600  # 1 hour

    # Security configurations
    WTF_CSRF_ENABLED = True


class DevelopmentConfig(Config):
    DEBUG = True


class TestingConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = 'sqlite:///test.db'
    WTF_CSRF_ENABLED = False


class ProductionConfig(Config):
    # In production, ensure all these are set via environment variables
    SECRET_KEY = os.environ.get('SECRET_KEY')
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URI')
    SOCKETIO_CORS_ALLOWED_ORIGINS = os.environ.get('CORS_ORIGINS', '*')

    # Production security settings
    SESSION_COOKIE_SECURE = True  # Only send cookies over HTTPS
    REMEMBER_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    REMEMBER_COOKIE_HTTPONLY = True


# Configuration dictionary
config = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig
}


# Get current configuration
def get_config():
    env = os.environ.get('FLASK_ENV', 'default')
    return config.get(env)