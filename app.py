from flask import Flask, render_template, request, redirect, url_for, flash, session, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import generate_password_hash, check_password_hash
import os
from dotenv import load_dotenv
import uuid
import time

# Load environment variables
load_dotenv()

# Initialize Flask app
app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-key-change-in-production')
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv('DATABASE_URI', 'sqlite:///videochat.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize SQLAlchemy
db = SQLAlchemy(app)

# Initialize Flask-SocketIO
socketio = SocketIO(app, cors_allowed_origins="*")

# Initialize Flask-Login
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

# User model
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    email = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    
    def set_password(self, password):
        self.password_hash = generate_password_hash(password)
        
    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

# Chat model
class Chat(db.Model):
    id = db.Column(db.String(36), primary_key=True)
    user1_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    user2_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.Float, default=time.time)
    
    user1 = db.relationship('User', foreign_keys=[user1_id])
    user2 = db.relationship('User', foreign_keys=[user2_id])

# User loader for Flask-Login
@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# Global queue for matching users
waiting_users = []

# Routes
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')
        
        # Check if username or email already exists
        user_exists = User.query.filter_by(username=username).first()
        email_exists = User.query.filter_by(email=email).first()
        
        if user_exists:
            flash('Username already exists')
            return redirect(url_for('register'))
        
        if email_exists:
            flash('Email already exists')
            return redirect(url_for('register'))
        
        # Create new user
        user = User(username=username, email=email)
        user.set_password(password)
        
        db.session.add(user)
        db.session.commit()
        
        flash('Registration successful! Please log in.')
        return redirect(url_for('login'))
    
    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        user = User.query.filter_by(username=username).first()
        
        if not user or not user.check_password(password):
            flash('Invalid username or password')
            return redirect(url_for('login'))
        
        login_user(user)
        return redirect(url_for('index'))
    
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))

@app.route('/start-matching')
@login_required
def start_matching():
    # Remove user from waiting queue if they were already there
    global waiting_users
    waiting_users = [user for user in waiting_users if user != current_user.id]
    
    return render_template('matching.html')

@app.route('/chat/<chat_id>')
@login_required
def chat(chat_id):
    # Check if chat exists and user is a participant
    chat = Chat.query.get_or_404(chat_id)
    
    if current_user.id != chat.user1_id and current_user.id != chat.user2_id:
        flash('You are not authorized to access this chat')
        return redirect(url_for('index'))
    
    return render_template('chat.html', chat_id=chat_id)

# SocketIO event handlers
@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        print(f'Client connected: {current_user.username}')

@socketio.on('disconnect')
def handle_disconnect():
    if current_user.is_authenticated:
        print(f'Client disconnected: {current_user.username}')
        
        # Remove from waiting queue if they were waiting
        global waiting_users
        if current_user.id in waiting_users:
            waiting_users.remove(current_user.id)

@socketio.on('join_queue')
def handle_join_queue(data):
    if not current_user.is_authenticated:
        return
    
    # Add user to waiting queue
    global waiting_users
    user_id = current_user.id
    
    # Check if user is already in queue
    if user_id in waiting_users:
        return
    
    # Add user to waiting queue
    waiting_users.append(user_id)
    print(f'User {current_user.username} joined the waiting queue')
    
    # Check if there's someone else waiting
    if len(waiting_users) >= 2:
        # Get the first user in the queue (who is not the current user)
        other_users = [u for u in waiting_users if u != user_id]
        
        if other_users:
            partner_id = other_users[0]
            
            # Remove both users from the waiting queue
            waiting_users.remove(user_id)
            waiting_users.remove(partner_id)
            
            # Create a new chat
            chat_id = str(uuid.uuid4())
            chat = Chat(id=chat_id, user1_id=user_id, user2_id=partner_id)
            db.session.add(chat)
            db.session.commit()
            
            # Get partner information
            partner = User.query.get(partner_id)
            
            # Notify both users about the match
            emit('match_found', {
                'chat_id': chat_id,
                'partner': partner.username
            }, room=request.sid)
            
            # Find the partner's socket and notify them
            for connected_sid in socketio.server.sockets:
                socket_session = socketio.server.sockets[connected_sid]
                if hasattr(socket_session, 'user_id') and socket_session.user_id == partner_id:
                    emit('match_found', {
                        'chat_id': chat_id,
                        'partner': current_user.username
                    }, room=connected_sid)
                    break

@socketio.on('join_chat')
def handle_join_chat(data):
    if not current_user.is_authenticated:
        return
    
    chat_id = data.get('chat_id')
    
    # Check if chat exists and user is a participant
    chat = Chat.query.get(chat_id)
    if not chat or (current_user.id != chat.user1_id and current_user.id != chat.user2_id):
        return
    
    # Join the chat room
    join_room(chat_id)
    
    # Set current user's partner
    partner_id = chat.user2_id if current_user.id == chat.user1_id else chat.user1_id
    partner = User.query.get(partner_id)
    
    # Notify user about join
    emit('chat_joined', {
        'username': current_user.username,
        'partner': partner.username
    }, room=chat_id)

@socketio.on('leave_chat')
def handle_leave_chat(data):
    if not current_user.is_authenticated:
        return
    
    chat_id = data.get('chat_id')
    
    # Leave the chat room
    leave_room(chat_id)
    
    # Notify others about leave
    emit('user_left', {
        'username': current_user.username
    }, room=chat_id)

@socketio.on('offer')
def handle_offer(data):
    emit('offer', data, room=data['chat_id'])

@socketio.on('answer')
def handle_answer(data):
    emit('answer', data, room=data['chat_id'])

@socketio.on('ice_candidate')
def handle_ice_candidate(data):
    emit('ice_candidate', data, room=data['chat_id'])

@socketio.on('chat_message')
def handle_chat_message(data):
    if not current_user.is_authenticated:
        return
    
    chat_id = data.get('chat_id')
    message = data.get('message')
    
    # Check if chat exists and user is a participant
    chat = Chat.query.get(chat_id)
    if not chat or (current_user.id != chat.user1_id and current_user.id != chat.user2_id):
        return
    
    # Send message to the chat room
    emit('chat_message', {
        'username': current_user.username,
        'message': message
    }, room=chat_id)

# Create database tables
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    socketio.run(app, debug=True)