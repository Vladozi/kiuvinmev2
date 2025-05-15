from flask import Flask, render_template, request, redirect, url_for, flash, session, jsonify, send_file
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import os
from dotenv import load_dotenv
import uuid
import time
import string
import random
from datetime import datetime, timedelta

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-key-change-in-production')
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv('DATABASE_URI', 'sqlite:///videochat.db')

if app.config['SQLALCHEMY_DATABASE_URI'] and app.config['SQLALCHEMY_DATABASE_URI'].startswith("postgres://"):
    app.config['SQLALCHEMY_DATABASE_URI'] = app.config['SQLALCHEMY_DATABASE_URI'].replace("postgres://", "postgresql://", 1)

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Add custom Jinja2 filters and globals
@app.template_filter('datetime')
def format_datetime(value, format='%Y-%m-%d %H:%M'):
    """Format a timestamp to datetime."""
    if value is None:
        return ""
    # Convert to datetime object
    dt = datetime.fromtimestamp(float(value))
    return dt.strftime(format)

# Make time module available in templates
@app.context_processor
def inject_time():
    return {'time': time}

# Add helper for checking if a user has upvoted a rating
@app.context_processor
def inject_has_upvoted():
    def has_upvoted(rating_id):
        if current_user.is_authenticated:
            return RatingUpvote.query.filter_by(
                rating_id=rating_id,
                user_id=current_user.id
            ).count() > 0
        return False
    return {'has_upvoted': has_upvoted}

# Configuration for recordings
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static/recordings')
ALLOWED_EXTENSIONS = {'webm', 'mp4'}
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500 MB max file size

db = SQLAlchemy(app)

# Initialize Flask-SocketIO
socketio = SocketIO(app, cors_allowed_origins="*")

# Initialize Flask-Login
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

#
# DATABASE MODELS
#

# User model
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    email = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    
    # Relationships
    rooms_hosted = db.relationship('Room', backref='host', lazy='dynamic')
    recordings = db.relationship('Recording', backref='user', lazy='dynamic')
    ratings = db.relationship('Rating', backref='user', lazy='dynamic')
    
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

# Room model for group chats
class Room(db.Model):
    id = db.Column(db.String(6), primary_key=True)  # 6-digit room code
    name = db.Column(db.String(100), nullable=False)
    host_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.Float, default=time.time)
    is_active = db.Column(db.Boolean, default=True)
    max_participants = db.Column(db.Integer, default=10)
    
    participants = db.relationship('RoomParticipant', backref='room', lazy='dynamic', cascade="all, delete-orphan")

# New model for department chat rooms
class ChatRoom(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    code = db.Column(db.String(20), unique=True, nullable=False)  # Room code/identifier
    description = db.Column(db.Text, nullable=True)
    is_department = db.Column(db.Boolean, default=False)  # Is it a department chat (vs private)
    department = db.Column(db.String(50), nullable=True)  # Department name if applicable
    is_private = db.Column(db.Boolean, default=False)  # Is it private (requires invite)
    created_at = db.Column(db.Float, default=time.time)
    creator_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)  # Can be null for system rooms
    
    creator = db.relationship('User', backref='created_chatrooms')
    messages = db.relationship('ChatMessage', backref='chatroom', lazy='dynamic', cascade="all, delete-orphan")
    participants = db.relationship('ChatParticipant', backref='chatroom', lazy='dynamic', cascade="all, delete-orphan")

# Chat participant model
class ChatParticipant(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    chatroom_id = db.Column(db.Integer, db.ForeignKey('chat_room.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    joined_at = db.Column(db.Float, default=time.time)
    last_read = db.Column(db.Float, default=time.time)  # Last time user read messages
    is_admin = db.Column(db.Boolean, default=False)  # Admin privileges
    
    user = db.relationship('User', backref='chatroom_participants')
    
    __table_args__ = (db.UniqueConstraint('chatroom_id', 'user_id', name='unique_chatroom_participant'),)

# Chat message model
class ChatMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    chatroom_id = db.Column(db.Integer, db.ForeignKey('chat_room.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    message = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.Float, default=time.time)
    
    user = db.relationship('User', backref='chat_messages')

# RoomParticipant model to track users in a room
class RoomParticipant(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.String(6), db.ForeignKey('room.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    joined_at = db.Column(db.Float, default=time.time)
    is_active = db.Column(db.Boolean, default=True)
    
    user = db.relationship('User', foreign_keys=[user_id])

# Recording model to track video recordings
class Recording(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    room_id = db.Column(db.String(6), db.ForeignKey('room.id', ondelete='SET NULL'), nullable=True)
    chat_id = db.Column(db.String(36), db.ForeignKey('chat.id', ondelete='SET NULL'), nullable=True)
    filename = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.Float, default=time.time)
    expires_at = db.Column(db.Float)  # When the recording will be deleted
    download_count = db.Column(db.Integer, default=0)
    file_size = db.Column(db.Integer)  # Size in bytes

# Rating model for site feedback
class Rating(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    stars = db.Column(db.Integer, nullable=False)  # 1-5 stars
    comment = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.Float, default=time.time)
    is_approved = db.Column(db.Boolean, default=True)  # For moderation
    upvotes = db.Column(db.Integer, default=0)  # For sorting top comments
    
    # Add relationship to upvotes
    upvotes_users = db.relationship('RatingUpvote', backref='rating', lazy='dynamic', cascade="all, delete-orphan")

# RatingUpvote model to track upvotes
class RatingUpvote(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    rating_id = db.Column(db.Integer, db.ForeignKey('rating.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.Float, default=time.time)
    
    # Add a unique constraint to prevent multiple upvotes
    __table_args__ = (db.UniqueConstraint('rating_id', 'user_id', name='unique_rating_upvote'),)

# Statistics models
class UserStatistics(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    profile_views = db.Column(db.Integer, default=0)
    last_seen = db.Column(db.Float, default=time.time)
    chats_participated = db.Column(db.Integer, default=0)
    
    user = db.relationship('User', backref=db.backref('statistics', uselist=False))

class DailyStatistics(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, default=lambda: datetime.now().date(), nullable=False)
    chat_count = db.Column(db.Integer, default=0)
    active_users = db.Column(db.Integer, default=0)
    
    __table_args__ = (db.UniqueConstraint('date', name='unique_date'),)

# Helper functions
def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def generate_room_code():
    while True:
        # Generate a 6-character alphanumeric code
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        # Check if it already exists
        if not Room.query.get(code):
            return code

def generate_chat_code():
    while True:
        # Generate a 6-character alphanumeric code
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        # Check if it already exists
        if not ChatRoom.query.filter_by(code=code).first():
            return code

# User loader for Flask-Login
@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# Global queue for matching users
waiting_users = []
# Dictionary to store user_id -> session_id mapping
user_sessions = {}
# Global variable to store room participants' socket sessions
room_sessions = {}
# Dictionary to store chat room participants' socket sessions
chatroom_sessions = {}

# Statistics functions
def get_or_create_user_statistics(user_id):
    """Get or create user statistics record"""
    stats = UserStatistics.query.filter_by(user_id=user_id).first()
    if not stats:
        stats = UserStatistics(user_id=user_id)
        db.session.add(stats)
        db.session.commit()
    return stats

def update_user_last_seen(user_id):
    """Update user's last seen timestamp"""
    stats = get_or_create_user_statistics(user_id)
    stats.last_seen = time.time()
    db.session.commit()
    return stats

def increment_profile_views(user_id):
    """Increment profile views counter for a user"""
    stats = get_or_create_user_statistics(user_id)
    stats.profile_views += 1
    db.session.commit()
    return stats

def increment_user_chats(user_id):
    """Increment the number of chats a user has participated in"""
    stats = get_or_create_user_statistics(user_id)
    stats.chats_participated += 1
    db.session.commit()
    return stats

def get_or_create_daily_statistics():
    """Get or create daily statistics record for today"""
    today = datetime.now().date()
    daily_stats = DailyStatistics.query.filter_by(date=today).first()
    if not daily_stats:
        daily_stats = DailyStatistics(date=today)
        db.session.add(daily_stats)
        db.session.commit()
    return daily_stats

def increment_daily_chat_count():
    """Increment the chat count for today"""
    daily_stats = get_or_create_daily_statistics()
    daily_stats.chat_count += 1
    db.session.commit()
    return daily_stats

def update_active_users_count():
    """Update the count of active users for today"""
    five_minutes_ago = time.time() - 300  # 5 minutes in seconds
    active_count = UserStatistics.query.filter(UserStatistics.last_seen > five_minutes_ago).count()
    
    daily_stats = get_or_create_daily_statistics()
    daily_stats.active_users = max(daily_stats.active_users, active_count)
    db.session.commit()
    return daily_stats

# Function to create or get department chat rooms
def create_default_chatrooms():
    """Create department chat rooms if they don't exist"""
    default_rooms = [
        {
            'name': 'ზოგადი ჯგუფი', 
            'code': 'GLOBAL', 
            'description': 'Global chat for all users', 
            'is_department': False,
            'department': None,
            'is_private': False
        },
        {
            'name': 'კომპიუტერული მეცნიერება', 
            'code': 'CS', 
            'description': 'Chat for Computer Science students', 
            'is_department': True,
            'department': 'Computer Science',
            'is_private': False
        },
        {
            'name': 'მენეჯმენტი', 
            'code': 'MGMT', 
            'description': 'Chat for Management students', 
            'is_department': True,
            'department': 'Management',
            'is_private': False
        },
        {
            'name': 'მათემატიკა', 
            'code': 'MATH', 
            'description': 'Chat for Mathematics students', 
            'is_department': True,
            'department': 'Mathematics',
            'is_private': False
        },
        {
            'name': 'მათემატიკა & გამოყენებები', 
            'code': 'MATHAPP', 
            'description': 'Chat for Mathematics & Applications students', 
            'is_department': True,
            'department': 'Mathematics & Applications',
            'is_private': False
        },
        {
            'name': 'დიზაინი', 
            'code': 'DESIGN', 
            'description': 'Chat for Design students', 
            'is_department': True,
            'department': 'Design',
            'is_private': False
        },
        {
            'name': 'მედიცინა', 
            'code': 'MED', 
            'description': 'Chat for Medicine students', 
            'is_department': True,
            'department': 'Medicine',
            'is_private': False
        },
        {
            'name': 'ფსიქოლოგია', 
            'code': 'PSYCH', 
            'description': 'Chat for Psychology students', 
            'is_department': True,
            'department': 'Psychology',
            'is_private': False
        },
        {
            'name': 'სამართალთმცოდნეობა', 
            'code': 'LAW', 
            'description': 'Chat for Law students', 
            'is_department': True,
            'department': 'Law',
            'is_private': False
        }
    ]
    
    for room_data in default_rooms:
        # Check if room exists
        room = ChatRoom.query.filter_by(code=room_data['code']).first()
        if not room:
            # Create room
            room = ChatRoom(
                name=room_data['name'],
                code=room_data['code'],
                description=room_data['description'],
                is_department=room_data['is_department'],
                department=room_data['department'],
                is_private=room_data['is_private']
            )
            db.session.add(room)
    
    db.session.commit()
    return True

# Routes
@app.route('/')
def index():
    # Update last seen for current user if authenticated
    if current_user.is_authenticated:
        update_user_last_seen(current_user.id)
    
    # Update active users count
    update_active_users_count()
    
    # Get top rated comments for display
    top_comments = Rating.query.filter_by(is_approved=True) \
                              .filter(Rating.comment != '') \
                              .order_by(Rating.upvotes.desc(), Rating.created_at.desc()) \
                              .limit(5).all()
    
    # Calculate average rating
    ratings = Rating.query.filter_by(is_approved=True).all()
    avg_rating = 0
    if ratings:
        avg_rating = sum(r.stars for r in ratings) / len(ratings)
    
    return render_template('index.html', top_comments=top_comments, avg_rating=avg_rating)

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
        
        # Initialize user statistics
        get_or_create_user_statistics(user.id)
        
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
        
        # Update last seen time
        update_user_last_seen(user.id)
        
        return redirect(url_for('index'))
    
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    # Clean up any socket sessions
    user_id = current_user.id
    if user_id in user_sessions:
        del user_sessions[user_id]
    
    # Remove from waiting queue if present
    global waiting_users
    if user_id in waiting_users:
        waiting_users.remove(user_id)
    
    # Mark as inactive in any group rooms
    participants = RoomParticipant.query.filter_by(
        user_id=current_user.id,
        is_active=True
    ).all()
    
    for participant in participants:
        participant.is_active = False
    
    db.session.commit()
        
    logout_user()
    return redirect(url_for('index'))

@app.route('/start-matching')
@login_required
def start_matching():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Remove user from waiting queue if they were already there
    global waiting_users
    user_id = current_user.id
    if user_id in waiting_users:
        waiting_users.remove(user_id)
    
    return render_template('matching.html')

@app.route('/chat/<chat_id>')
@login_required
def chat(chat_id):
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Check if chat exists and user is a participant
    chat = Chat.query.get_or_404(chat_id)
    
    if current_user.id != chat.user1_id and current_user.id != chat.user2_id:
        flash('You are not authorized to access this chat')
        return redirect(url_for('index'))
    
    # Get partner's username
    if current_user.id == chat.user1_id:
        partner = User.query.get(chat.user2_id)
    else:
        partner = User.query.get(chat.user1_id)
    
    partner_username = partner.username if partner else "Unknown"
    
    return render_template('chat.html', chat_id=chat_id, partner_username=partner_username)

# Chatting system routes
@app.route('/chatting')
@login_required
def chatting_index():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Ensure default chat rooms exist
    create_default_chatrooms()
    
    # Get department chat rooms
    department_rooms = ChatRoom.query.filter_by(is_department=True, is_private=False).all()
    
    # Get global chat room
    global_room = ChatRoom.query.filter_by(code='GLOBAL').first()
    
    # Get user's private chat rooms (either created or participated in)
    private_rooms_created = ChatRoom.query.filter_by(creator_id=current_user.id, is_private=True).all()
    
    # Get rooms user is participating in but didn't create
    private_rooms_joined = ChatRoom.query.join(ChatParticipant).filter(
        ChatRoom.is_private == True,
        ChatParticipant.user_id == current_user.id,
        ChatRoom.creator_id != current_user.id
    ).all()
    
    return render_template(
        'chatting_index.html',
        global_room=global_room,
        department_rooms=department_rooms,
        private_rooms_created=private_rooms_created,
        private_rooms_joined=private_rooms_joined
    )

@app.route('/chatting/room/<room_code>')
@login_required
def chatting_room(room_code):
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first_or_404()
    
    # Check if this is a private room and if user has access
    if room.is_private:
        # Check if user is creator or participant
        is_participant = ChatParticipant.query.filter_by(
            chatroom_id=room.id,
            user_id=current_user.id
        ).first() or room.creator_id == current_user.id
        
        if not is_participant:
            flash('You do not have access to this chat room')
            return redirect(url_for('chatting_index'))
    
    # If user is not already a participant, add them
    participant = ChatParticipant.query.filter_by(
        chatroom_id=room.id,
        user_id=current_user.id
    ).first()
    
    if not participant:
        # Add user as participant
        participant = ChatParticipant(
            chatroom_id=room.id,
            user_id=current_user.id,
            is_admin=(room.creator_id == current_user.id)  # Creator is admin
        )
        db.session.add(participant)
        db.session.commit()
    
    # Get recent messages (last 100)
    messages = ChatMessage.query.filter_by(
        chatroom_id=room.id
    ).order_by(ChatMessage.created_at).limit(100).all()
    
    # Get participants
    participants = ChatParticipant.query.filter_by(
        chatroom_id=room.id
    ).all()
    
    # Get participant users
    participant_users = []
    for p in participants:
        user = User.query.get(p.user_id)
        if user:
            participant_users.append({
                'id': user.id,
                'username': user.username,
                'is_admin': p.is_admin
            })
    
    # Update last read timestamp
    if participant:
        participant.last_read = time.time()
        db.session.commit()
    
    # Check if user is admin
    is_admin = participant and participant.is_admin
    
    return render_template(
        'chatting_room.html',
        room=room,
        messages=messages,
        participants=participant_users,
        is_admin=is_admin
    )

@app.route('/chatting/create', methods=['GET', 'POST'])
@login_required
def create_chatroom():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    if request.method == 'POST':
        room_name = request.form.get('room_name')
        description = request.form.get('description', '')
        
        if not room_name:
            flash('Room name is required')
            return redirect(url_for('create_chatroom'))
        
        # Generate a unique code
        room_code = generate_chat_code()
        
        # Create the room
        room = ChatRoom(
            name=room_name,
            code=room_code,
            description=description,
            is_private=True,
            creator_id=current_user.id
        )
        
        db.session.add(room)
        db.session.commit()
        
        # Add creator as participant and admin
        participant = ChatParticipant(
            chatroom_id=room.id,
            user_id=current_user.id,
            is_admin=True
        )
        
        db.session.add(participant)
        db.session.commit()
        
        flash(f'Chat room created successfully! Room code: {room_code}')
        return redirect(url_for('chatting_room', room_code=room_code))
    
    return render_template('create_chatroom.html')

@app.route('/chatting/join', methods=['GET', 'POST'])
@login_required
def join_chatroom():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    if request.method == 'POST':
        room_code = request.form.get('room_code')
        
        if not room_code:
            flash('Room code is required')
            return redirect(url_for('join_chatroom'))
        
        # Find the room
        room = ChatRoom.query.filter_by(code=room_code).first()
        
        if not room:
            flash('Invalid room code')
            return redirect(url_for('join_chatroom'))
        
        # Check if user is already a participant
        participant = ChatParticipant.query.filter_by(
            chatroom_id=room.id,
            user_id=current_user.id
        ).first()
        
        if not participant:
            # Add user as participant
            participant = ChatParticipant(
                chatroom_id=room.id,
                user_id=current_user.id,
                is_admin=False
            )
            db.session.add(participant)
            db.session.commit()
        
        return redirect(url_for('chatting_room', room_code=room_code))
    
    return render_template('join_chatroom.html')

@app.route('/chatting/join-department/<room_code>')
@login_required
def join_department_chat(room_code):
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Find the room
    room = ChatRoom.query.filter_by(code=room_code, is_department=True).first_or_404()
    
    # Check if the user is already in a department chat
    existing_department_participant = ChatParticipant.query.join(ChatRoom).filter(
        ChatParticipant.user_id == current_user.id,
        ChatRoom.is_department == True,
        ChatRoom.code != 'GLOBAL'
    ).first()
    
    if existing_department_participant:
        # User is already in a department chat, they can't join another one
        flash('თქვენ უკვე შემოსული ხართ სხვა კატეგორიის ჩატში. მხოლოდ ერთ კატეგორიაში შეგიძლიათ შესვლა.')
        return redirect(url_for('chatting_index'))
    
    # Add user as participant
    participant = ChatParticipant(
        chatroom_id=room.id,
        user_id=current_user.id,
        is_admin=False
    )
    db.session.add(participant)
    db.session.commit()
    
    flash(f'თქვენ წარმატებით შეუერთდით "{room.name}"-ს')
    return redirect(url_for('chatting_room', room_code=room_code))

@app.route('/chatting/leave/<room_code>')
@login_required
def leave_chatroom(room_code):
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first_or_404()
    
    # Check if this is the GLOBAL chat
    if room.code == 'GLOBAL':
        flash('თქვენ ვერ დატოვებთ ზოგად ჩატს')
        return redirect(url_for('chatting_index'))
    
    # Get the participant
    participant = ChatParticipant.query.filter_by(
        chatroom_id=room.id,
        user_id=current_user.id
    ).first_or_404()
    
    # Delete the participant
    db.session.delete(participant)
    db.session.commit()
    
    flash(f'თქვენ წარმატებით დატოვეთ "{room.name}"')
    return redirect(url_for('chatting_index'))

@app.route('/chatting/delete/<room_code>')
@login_required
def delete_chatroom(room_code):
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first_or_404()
    
    # Check if user is the creator
    if room.creator_id != current_user.id:
        flash('თქვენ არ გაქვთ უფლება წაშალოთ ეს ჩატი')
        return redirect(url_for('chatting_index'))
    
    # Check if this is a system room
    if room.is_department or room.code == 'GLOBAL':
        flash('თქვენ ვერ წაშლით სისტემურ ჩატს')
        return redirect(url_for('chatting_index'))
    
    # Delete all messages in the room
    ChatMessage.query.filter_by(chatroom_id=room.id).delete()
    
    # Delete all participants
    ChatParticipant.query.filter_by(chatroom_id=room.id).delete()
    
    # Delete the room
    db.session.delete(room)
    db.session.commit()
    
    flash('ჩატი წარმატებით წაიშალა')
    return redirect(url_for('chatting_index'))

@app.route('/chatting/manage/<room_code>', methods=['GET', 'POST'])
@login_required
def manage_chatroom(room_code):
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first_or_404()
    
    # Check if user is admin
    participant = ChatParticipant.query.filter_by(
        chatroom_id=room.id,
        user_id=current_user.id
    ).first()
    
    if not participant or not participant.is_admin:
        flash('You do not have permission to manage this room')
        return redirect(url_for('chatting_room', room_code=room_code))
    
    # Get participants
    participants = ChatParticipant.query.filter_by(
        chatroom_id=room.id
    ).all()
    
    # Get participant users
    participant_users = []
    for p in participants:
        user = User.query.get(p.user_id)
        if user:
            participant_users.append({
                'id': user.id,
                'username': user.username,
                'is_admin': p.is_admin,
                'participant_id': p.id
            })
    
    if request.method == 'POST':
        action = request.form.get('action')
        
        if action == 'update_room':
            # Update room details
            room_name = request.form.get('room_name')
            description = request.form.get('description')
            
            if room_name:
                room.name = room_name
            
            room.description = description
            db.session.commit()
            
            flash('Room details updated successfully')
        
        elif action == 'toggle_admin':
            # Toggle admin status
            participant_id = request.form.get('participant_id')
            
            if participant_id:
                p = ChatParticipant.query.get(participant_id)
                if p and p.chatroom_id == room.id:
                    p.is_admin = not p.is_admin
                    db.session.commit()
                    flash('Admin status updated')
        
        elif action == 'remove_participant':
            # Remove participant
            participant_id = request.form.get('participant_id')
            
            if participant_id:
                p = ChatParticipant.query.get(participant_id)
                if p and p.chatroom_id == room.id:
                    db.session.delete(p)
                    db.session.commit()
                    flash('Participant removed')
        
        return redirect(url_for('manage_chatroom', room_code=room_code))
    
    return render_template(
        'manage_chatroom.html',
        room=room,
        participants=participant_users
    )

# Get statistics via AJAX
@app.route('/get-statistics')
@login_required
def get_statistics():
    try:
        if not current_user.is_authenticated:
            return jsonify({
                'online_count': 0,
                'chats_count': 0,
                'profile_views': 0
            })
        
        # Update user's last seen time
        stats = UserStatistics.query.filter_by(user_id=current_user.id).first()
        if not stats:
            # Create statistics record if it doesn't exist
            stats = UserStatistics(
                user_id=current_user.id,
                profile_views=0,
                last_seen=time.time(),
                chats_participated=0
            )
            db.session.add(stats)
        else:
            # Update last seen timestamp
            stats.last_seen = time.time()
        
        db.session.commit()
        
        # Get online users count
        five_minutes_ago = time.time() - 300  # 5 minutes in seconds
        online_count = UserStatistics.query.filter(UserStatistics.last_seen > five_minutes_ago).count()
        
        # Get today's chat count
        today = datetime.now().date()
        daily_stat = DailyStatistics.query.filter_by(date=today).first()
        
        if not daily_stat:
            # Create daily statistics record if it doesn't exist
            daily_stat = DailyStatistics(
                date=today,
                chat_count=0,
                active_users=0
            )
            db.session.add(daily_stat)
            db.session.commit()
            chats_count = 0
        else:
            chats_count = daily_stat.chat_count
        
        # Get user's profile views
        profile_views = stats.profile_views
        
        return jsonify({
            'online_count': online_count,
            'chats_count': chats_count,
            'profile_views': profile_views
        })
    
    except Exception as e:
        # Log the error for debugging
        print(f"Error in get_statistics: {str(e)}")
        
        # Return zeros instead of error
        return jsonify({
            'online_count': 0,
            'chats_count': 0,
            'profile_views': 0
        }), 200  # Return 200 OK even though there was an error

# Group Chat Routes
@app.route('/group-chat')
@login_required
def group_chat_index():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Get rooms created by the user
    hosted_rooms = Room.query.filter_by(host_id=current_user.id, is_active=True).all()
    
    # Get rooms the user has participated in
    participated_rooms = Room.query.join(RoomParticipant).filter(
        RoomParticipant.user_id == current_user.id,
        RoomParticipant.is_active == True,
        Room.is_active == True
    ).all()
    
    return render_template(
        'group_chat_index.html', 
        hosted_rooms=hosted_rooms, 
        participated_rooms=participated_rooms
    )

@app.route('/create-room', methods=['GET', 'POST'])
@login_required
def create_room():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    if request.method == 'POST':
        room_name = request.form.get('room_name')
        max_participants = int(request.form.get('max_participants', 10))
        
        # Generate a unique room code
        room_code = generate_room_code()
        
        # Create the room
        room = Room(
            id=room_code,
            name=room_name,
            host_id=current_user.id,
            max_participants=max_participants
        )
        
        db.session.add(room)
        db.session.commit()
        
        # Add the host as a participant
        participant = RoomParticipant(
            room_id=room_code,
            user_id=current_user.id
        )
        
        db.session.add(participant)
        db.session.commit()
        
        flash(f'Room created successfully! Room code: {room_code}')
        return redirect(url_for('room', room_id=room_code))
    
    return render_template('create_room.html')

@app.route('/join-room', methods=['GET', 'POST'])
@login_required
def join_room_page():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    if request.method == 'POST':
        room_code = request.form.get('room_code')
        
        # Check if room exists
        room = Room.query.get(room_code)
        if not room:
            flash('Invalid room code')
            return redirect(url_for('join_room_page'))
        
        if not room.is_active:
            flash('This room is no longer active')
            return redirect(url_for('join_room_page'))
        
        # Check if room is full
        active_participants = RoomParticipant.query.filter_by(
            room_id=room_code, 
            is_active=True
        ).count()
        
        if active_participants >= room.max_participants:
            flash('Room is full')
            return redirect(url_for('join_room_page'))
        
        # Check if user is already a participant
        participant = RoomParticipant.query.filter_by(
            room_id=room_code,
            user_id=current_user.id
        ).first()
        
        if participant:
            # If they're already a participant but marked inactive, mark them active
            if not participant.is_active:
                participant.is_active = True
                participant.joined_at = time.time()
                db.session.commit()
        else:
            # Add the user as a participant
            participant = RoomParticipant(
                room_id=room_code,
                user_id=current_user.id
            )
            db.session.add(participant)
            db.session.commit()
        
        return redirect(url_for('room', room_id=room_code))
    
    return render_template('join_room.html')

@app.route('/room/<room_id>')
@login_required
def room(room_id):
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Check if room exists
    room = Room.query.get_or_404(room_id)
    
    # Check if room is active
    if not room.is_active:
        flash('This room is no longer active')
        return redirect(url_for('group_chat_index'))
    
    # Check if user is a participant
    participant = RoomParticipant.query.filter_by(
        room_id=room_id,
        user_id=current_user.id
    ).first()
    
    if not participant:
        flash('You are not a participant in this room')
        return redirect(url_for('group_chat_index'))
    
    # Get all active participants
    participants = RoomParticipant.query.filter_by(
        room_id=room_id,
        is_active=True
    ).all()
    
    # Get user info for all participants
    participants_info = []
    for p in participants:
        user = User.query.get(p.user_id)
        participants_info.append({
            'id': user.id,
            'username': user.username,
            'is_host': user.id == room.host_id
        })
    
    is_host = current_user.id == room.host_id
    
    return render_template(
        'room.html', 
        room=room, 
        participants=participants_info,
        is_host=is_host
    )

# Debug route to see current waiting users
@app.route('/debug/waiting')
@login_required
def debug_waiting():
    return jsonify({
        'waiting_users': waiting_users,
        'user_sessions': list(user_sessions.keys())
    })

# User profile route with view tracking
@app.route('/user/<username>')
def user_profile(username):
    user = User.query.filter_by(username=username).first_or_404()
    
    # Don't increment if viewing own profile
    if current_user.is_authenticated and current_user.id != user.id:
        increment_profile_views(user.id)
    
    # Implement the rest of your profile view logic here
    return render_template('user_profile.html', user=user)

# Recording Routes
@app.route('/upload-recording', methods=['POST'])
@login_required
def upload_recording():
    if 'recording' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    
    file = request.files['recording']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file and allowed_file(file.filename):
        # Generate unique filename
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        filename = f"{current_user.id}_{timestamp}_{secure_filename(file.filename)}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        
        # Save the file
        file.save(file_path)
        
        # Calculate expiration (24 hours from now)
        expires_at = time.time() + 86400  # 24 hours in seconds
        
        # Get file size
        file_size = os.path.getsize(file_path)
        
        # Only reject completely empty files (0 bytes)
        # Short videos can be very small but still valid
        if file_size == 0:
            # File is completely empty
            if os.path.exists(file_path):
                os.remove(file_path)
            return jsonify({'error': 'Recording is empty'}), 400
        
        # Create recording record
        recording = Recording(
            user_id=current_user.id,
            room_id=request.form.get('room_id'),
            chat_id=request.form.get('chat_id'),
            filename=filename,
            expires_at=expires_at,
            file_size=file_size
        )
        
        db.session.add(recording)
        db.session.commit()
        
        # Generate download link
        download_link = url_for('download_recording', recording_id=recording.id, _external=True)
        
        return jsonify({
            'success': True,
            'download_link': download_link,
            'expires_at': expires_at
        })
    
    return jsonify({'error': 'Invalid file format'}), 400

@app.route('/download-recording/<recording_id>')
@login_required
def download_recording(recording_id):
    recording = Recording.query.get_or_404(recording_id)
    
    # Check if current user owns this recording
    if current_user.is_authenticated and recording.user_id != current_user.id:
        flash('You do not have permission to access this recording')
        return redirect(url_for('index'))
    
    # Check if recording has expired
    if recording.expires_at < time.time():
        flash('This recording has expired')
        return redirect(url_for('index'))
    
    # Increment download count
    recording.download_count += 1
    db.session.commit()
    
    # Generate file path
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], recording.filename)
    
    # Check if file exists
    if not os.path.exists(file_path):
        flash('Recording file not found')
        return redirect(url_for('index'))
    
    # Return file for download
    return send_file(
        file_path,
        as_attachment=True,
        download_name=f"recording_{recording_id}.{recording.filename.split('.')[-1]}"
    )

@app.route('/my-recordings')
@login_required
def my_recordings():
    # Update last seen time
    update_user_last_seen(current_user.id)
    
    # Get user's recordings that haven't expired
    recordings = Recording.query.filter(
        Recording.user_id == current_user.id,
        Recording.expires_at > time.time()
    ).order_by(Recording.created_at.desc()).all()
    
    return render_template('my_recordings.html', recordings=recordings)

@app.route('/delete-recording/<recording_id>', methods=['POST', 'GET'])
@login_required
def delete_recording(recording_id):
    # Find the recording
    recording = Recording.query.get_or_404(recording_id)
    
    # Check if current user owns this recording
    if recording.user_id != current_user.id:
        flash('You do not have permission to delete this recording')
        return redirect(url_for('my_recordings'))
    
    # Delete the file
    file_path = os.path.join(app.config['UPLOAD_FOLDER'], recording.filename)
    if os.path.exists(file_path):
        os.remove(file_path)
    
    # Delete the record from database
    db.session.delete(recording)
    db.session.commit()
    
    flash('Recording deleted successfully')
    return redirect(url_for('my_recordings'))

@app.route('/delete-room/<room_id>', methods=['POST', 'GET'])
@login_required
def delete_room(room_id):
    # Find the room
    room = Room.query.get_or_404(room_id)
    
    # Check if current user is the host
    if room.host_id != current_user.id:
        flash('Only the host can delete this room')
        return redirect(url_for('group_chat_index'))
    
    # Mark room as inactive (soft delete)
    room.is_active = False
    
    # Update all participants to inactive
    participants = RoomParticipant.query.filter_by(room_id=room_id).all()
    for participant in participants:
        participant.is_active = False
    
    db.session.commit()
    
    flash('Room deleted successfully')
    return redirect(url_for('group_chat_index'))

# Rating Routes
@app.route('/submit-rating', methods=['POST'])
@login_required
def submit_rating():
    stars = int(request.form.get('stars', 5))
    comment = request.form.get('comment', '')
    
    # Validate stars
    if stars < 1 or stars > 5:
        flash('Invalid rating value')
        return redirect(url_for('index'))
    
    # Check if user has already submitted a rating
    existing_rating = Rating.query.filter_by(user_id=current_user.id).first()
    
    if existing_rating:
        # Update existing rating
        existing_rating.stars = stars
        existing_rating.comment = comment
        existing_rating.created_at = time.time()
    else:
        # Create new rating
        rating = Rating(
            user_id=current_user.id,
            stars=stars,
            comment=comment
        )
        db.session.add(rating)
    
    db.session.commit()
    flash('Thank you for your feedback!')
    return redirect(url_for('index'))

@app.route('/upvote-comment/<rating_id>')
@login_required
def upvote_comment(rating_id):
    rating = Rating.query.get_or_404(rating_id)
    
    # Check if user has already upvoted this rating
    existing_upvote = RatingUpvote.query.filter_by(
        rating_id=rating.id,
        user_id=current_user.id
    ).first()
    
    if existing_upvote:
        # User already upvoted, return without incrementing
        flash('You have already upvoted this comment')
    else:
        # User has not upvoted, create upvote record and increment
        upvote = RatingUpvote(
            rating_id=rating.id,
            user_id=current_user.id
        )
        rating.upvotes += 1
        
        db.session.add(upvote)
        db.session.commit()
    
    return redirect(url_for('index'))

def cleanup_expired_recordings():
    # Find all expired recordings
    expired_recordings = Recording.query.filter(
        Recording.expires_at < time.time()
    ).all()
    
    for recording in expired_recordings:
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], recording.filename)
        
        # Delete the file if it exists
        if os.path.exists(file_path):
            os.remove(file_path)
        
        # Delete the record
        db.session.delete(recording)
    
    db.session.commit()
    print(f"Cleaned up {len(expired_recordings)} expired recordings")

# Socket.IO event handlers
@socketio.on('join_queue')
def handle_join_queue(data):
    if not current_user.is_authenticated:
        return
    
    username = data.get('username')
    user_id = current_user.id
    
    print(f'User {username} (ID: {user_id}) joined the queue')
    
    # Store user's session ID
    user_sessions[user_id] = request.sid
    
    # Add user to waiting queue
    global waiting_users
    if user_id not in waiting_users:
        waiting_users.append(user_id)
    
    # Check if we can match users
    if len(waiting_users) >= 2:
        # Get first two users
        user1_id = waiting_users.pop(0)
        user2_id = waiting_users.pop(0)
        
        user1 = User.query.get(user1_id)
        user2 = User.query.get(user2_id)
        
        if not user1 or not user2:
            # Re-add valid users back to queue
            if user1:
                waiting_users.append(user1_id)
            if user2:
                waiting_users.append(user2_id)
            return
        
        # Create a chat record
        chat_id = str(uuid.uuid4())
        chat = Chat(
            id=chat_id,
            user1_id=user1_id,
            user2_id=user2_id
        )
        
        db.session.add(chat)
        db.session.commit()
        
        # Increment statistics
        increment_daily_chat_count()
        increment_user_chats(user1_id)
        increment_user_chats(user2_id)
        
        # Notify both users
        if user1_id in user_sessions:
            emit('match_found', {
                'chat_id': chat_id,
                'partner': user2.username
            }, room=user_sessions[user1_id])
        
        if user2_id in user_sessions:
            emit('match_found', {
                'chat_id': chat_id,
                'partner': user1.username
            }, room=user_sessions[user2_id])

@socketio.on('join_chat')
def handle_join_chat(data):
    if not current_user.is_authenticated:
        return
    
    chat_id = data.get('chat_id')
    
    # Verify chat exists and user is a participant
    chat = Chat.query.get(chat_id)
    if not chat or (current_user.id != chat.user1_id and current_user.id != chat.user2_id):
        return
    
    # Join the socket room
    join_room(chat_id)
    print(f'User {current_user.username} joined chat room {chat_id}')
    
    # Get partner's info
    if current_user.id == chat.user1_id:
        partner = User.query.get(chat.user2_id)
        partner_id = chat.user2_id
    else:
        partner = User.query.get(chat.user1_id)
        partner_id = chat.user1_id
    
    partner_username = partner.username if partner else "Unknown"
    
    # Notify both users
    emit('chat_joined', {
        'username': current_user.username,
        'partner': partner_username
    }, room=chat_id)

@socketio.on('leave_chat')
def handle_leave_chat(data):
    if not current_user.is_authenticated:
        return
    
    chat_id = data.get('chat_id')
    
    # Leave the socket room
    leave_room(chat_id)
    print(f'User {current_user.username} left chat room {chat_id}')
    
    # Notify others
    emit('user_left', {
        'username': current_user.username
    }, room=chat_id)

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

# Chatting system Socket.IO handlers
@socketio.on('join_chatroom')
def handle_join_chatroom(data):
    if not current_user.is_authenticated:
        return
    
    room_code = data.get('room_code')
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first()
    if not room:
        return
    
    # Join the socket room
    join_room(f"chatroom_{room.id}")
    print(f'User {current_user.username} joined chatroom {room_code}')
    
    # Store user's session in chatroom_sessions
    if room.id not in chatroom_sessions:
        chatroom_sessions[room.id] = {}
    
    chatroom_sessions[room.id][current_user.id] = request.sid
    
    # Get participant
    participant = ChatParticipant.query.filter_by(
        chatroom_id=room.id,
        user_id=current_user.id
    ).first()
    
    # If user is not already a participant, add them
    if not participant:
        participant = ChatParticipant(
            chatroom_id=room.id,
            user_id=current_user.id,
            is_admin=(room.creator_id == current_user.id)  # Creator is admin
        )
        db.session.add(participant)
        db.session.commit()
    
    # Update last read timestamp
    participant.last_read = time.time()
    db.session.commit()
    
    # Get all participants
    participants = ChatParticipant.query.filter_by(
        chatroom_id=room.id
    ).all()
    
    participant_list = []
    for p in participants:
        user = User.query.get(p.user_id)
        if user:
            participant_list.append({
                'id': user.id,
                'username': user.username,
                'is_admin': p.is_admin
            })
    
    # Notify everyone about participants
    emit('chatroom_participants', {
        'participants': participant_list
    }, room=f"chatroom_{room.id}")
    
    # Notify about new user
    emit('chatroom_message', {
        'type': 'system',
        'content': f'{current_user.username} joined the chat'
    }, room=f"chatroom_{room.id}")

@socketio.on('leave_chatroom')
def handle_leave_chatroom(data):
    if not current_user.is_authenticated:
        return
    
    room_code = data.get('room_code')
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first()
    if not room:
        return
    
    # Leave the socket room
    leave_room(f"chatroom_{room.id}")
    print(f'User {current_user.username} left chatroom {room_code}')
    
    # Remove from chatroom_sessions
    if room.id in chatroom_sessions and current_user.id in chatroom_sessions[room.id]:
        del chatroom_sessions[room.id][current_user.id]
    
    # Notify everyone
    emit('chatroom_message', {
        'type': 'system',
        'content': f'{current_user.username} left the chat'
    }, room=f"chatroom_{room.id}")

@socketio.on('send_chatroom_message')
def handle_send_chatroom_message(data):
    if not current_user.is_authenticated:
        return
    
    room_code = data.get('room_code')
    message_text = data.get('message')
    
    if not message_text or not message_text.strip():
        return
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first()
    if not room:
        return
    
    # Create message record
    message = ChatMessage(
        chatroom_id=room.id,
        user_id=current_user.id,
        message=message_text
    )
    
    db.session.add(message)
    db.session.commit()
    
    # Send message to room
    emit('chatroom_message', {
        'type': 'user',
        'user_id': current_user.id,
        'username': current_user.username,
        'content': message_text,
        'timestamp': message.created_at
    }, room=f"chatroom_{room.id}")

@socketio.on('kick_user')
def handle_kick_user(data):
    if not current_user.is_authenticated:
        return
    
    room_code = data.get('room_code')
    user_id = data.get('user_id')
    
    # Get the chat room
    room = ChatRoom.query.filter_by(code=room_code).first()
    if not room:
        return
    
    # Check if current user is admin
    current_participant = ChatParticipant.query.filter_by(
        chatroom_id=room.id,
        user_id=current_user.id
    ).first()
    
    if not current_participant or not current_participant.is_admin:
        return
    
    # Find the participant to kick
    participant = ChatParticipant.query.filter_by(
        chatroom_id=room.id,
        user_id=user_id
    ).first()
    
    if not participant:
        return
    
    # Delete the participant
    db.session.delete(participant)
    db.session.commit()
    
    # Notify the kicked user
    if room.id in chatroom_sessions and user_id in chatroom_sessions[room.id]:
        emit('kicked_from_chatroom', {
            'room_code': room_code
        }, room=chatroom_sessions[room.id][user_id])
    
    # Notify everyone
    user = User.query.get(user_id)
    if user:
        emit('chatroom_message', {
            'type': 'system',
            'content': f'{user.username} was removed from the chat'
        }, room=f"chatroom_{room.id}")
    
    # Update participant list
    participants = ChatParticipant.query.filter_by(
        chatroom_id=room.id
    ).all()
    
    participant_list = []
    for p in participants:
        user = User.query.get(p.user_id)
        if user:
            participant_list.append({
                'id': user.id,
                'username': user.username,
                'is_admin': p.is_admin
            })
    
    # Notify everyone about participants
    emit('chatroom_participants', {
        'participants': participant_list
    }, room=f"chatroom_{room.id}")

# Group Chat Socket Handlers
@socketio.on('join_group_room')
def handle_join_group_room(data):
    if not current_user.is_authenticated:
        return
    
    room_id = data.get('room_id')
    print(f'User {current_user.username} joining group room {room_id}')
    
    # Check if room exists and user is a participant
    room = Room.query.get(room_id)
    if not room:
        print(f'Room {room_id} not found')
        return
    
    participant = RoomParticipant.query.filter_by(
        room_id=room_id,
        user_id=current_user.id
    ).first()
    
    if not participant:
        print(f'User {current_user.username} is not a participant in room {room_id}')
        return
    
    # Mark participant as active
    participant.is_active = True
    db.session.commit()
    
    # Join the room
    join_room(room_id)
    print(f'User {current_user.username} joined room {room_id}')
    
    # Store user's session for this room
    if room_id not in room_sessions:
        room_sessions[room_id] = {}
    
    room_sessions[room_id][current_user.id] = request.sid
    
    # Notify everyone in the room about the new participant
    participants = RoomParticipant.query.filter_by(
        room_id=room_id,
        is_active=True
    ).all()
    
    participant_list = []
    for p in participants:
        user = User.query.get(p.user_id)
        participant_list.append({
            'id': user.id,
            'username': user.username,
            'is_host': user.id == room.host_id
        })
    
    emit('group_room_participants', {
        'participants': participant_list
    }, room=room_id)
    
    # Also emit a join message
    emit('group_chat_message', {
        'type': 'system',
        'username': 'System',
        'message': f'{current_user.username} joined the room'
    }, room=room_id)

@socketio.on('leave_group_room')
def handle_leave_group_room(data):
    if not current_user.is_authenticated:
        return
    
    room_id = data.get('room_id')
    
    # Update participant status
    participant = RoomParticipant.query.filter_by(
        room_id=room_id,
        user_id=current_user.id
    ).first()
    
    if participant:
        participant.is_active = False
        db.session.commit()
    
    # Leave the socket room
    leave_room(room_id)
    
    # Remove from room sessions
    if room_id in room_sessions and current_user.id in room_sessions[room_id]:
        del room_sessions[room_id][current_user.id]
    
    # Notify others
    emit('group_chat_message', {
        'type': 'system',
        'username': 'System',
        'message': f'{current_user.username} left the room'
    }, room=room_id)
    
    # Update participant list
    participants = RoomParticipant.query.filter_by(
        room_id=room_id,
        is_active=True
    ).all()
    
    room = Room.query.get(room_id)
    if not room:
        return
    
    participant_list = []
    for p in participants:
        user = User.query.get(p.user_id)
        participant_list.append({
            'id': user.id,
            'username': user.username,
            'is_host': user.id == room.host_id
        })
    
    emit('group_room_participants', {
        'participants': participant_list
    }, room=room_id)

@socketio.on('group_chat_message')
def handle_group_chat_message(data):
    if not current_user.is_authenticated:
        return
    
    room_id = data.get('room_id')
    message = data.get('message')
    
    # Check if user is in the room
    participant = RoomParticipant.query.filter_by(
        room_id=room_id,
        user_id=current_user.id,
        is_active=True
    ).first()
    
    if not participant:
        return
    
    # Send message to everyone in the room
    emit('group_chat_message', {
        'type': 'user',
        'username': current_user.username,
        'user_id': current_user.id,
        'message': message
    }, room=room_id)

@socketio.on('group_room_offer')
def handle_group_room_offer(data):
    room_id = data.get('room_id')
    target_id = data.get('target_id')
    offer = data.get('offer')
    
    # Send the offer to the specific user
    if (room_id in room_sessions and 
        target_id in room_sessions[room_id]):
        target_sid = room_sessions[room_id][target_id]
        
        emit('group_room_offer', {
            'room_id': room_id,
            'sender_id': current_user.id,
            'sender_username': current_user.username,
            'offer': offer
        }, room=target_sid)

@socketio.on('group_room_answer')
def handle_group_room_answer(data):
    room_id = data.get('room_id')
    target_id = data.get('target_id')
    answer = data.get('answer')
    
    # Send the answer to the specific user
    if (room_id in room_sessions and 
        target_id in room_sessions[room_id]):
        target_sid = room_sessions[room_id][target_id]
        
        emit('group_room_answer', {
            'room_id': room_id,
            'sender_id': current_user.id,
            'answer': answer
        }, room=target_sid)

@socketio.on('group_room_ice_candidate')
def handle_group_room_ice_candidate(data):
    room_id = data.get('room_id')
    target_id = data.get('target_id')
    candidate = data.get('candidate')
    
    # Send the ICE candidate to the specific user
    if (room_id in room_sessions and 
        target_id in room_sessions[room_id]):
        target_sid = room_sessions[room_id][target_id]
        
        emit('group_room_ice_candidate', {
            'room_id': room_id,
            'sender_id': current_user.id,
            'candidate': candidate
        }, room=target_sid)

@socketio.on('remove_participant')
def handle_remove_participant(data):
    if not current_user.is_authenticated:
        return
    
    room_id = data.get('room_id')
    target_id = data.get('target_id')
    
    # Check if the current user is the host
    room = Room.query.get(room_id)
    if not room or room.host_id != current_user.id:
        return
    
    # Find the participant
    participant = RoomParticipant.query.filter_by(
        room_id=room_id,
        user_id=target_id,
        is_active=True
    ).first()
    
    if not participant:
        return
    
    # Mark as inactive
    participant.is_active = False
    db.session.commit()
    
    # Notify the removed user
    if (room_id in room_sessions and 
        target_id in room_sessions[room_id]):
        target_sid = room_sessions[room_id][target_id]
        
        emit('participant_removed', {
            'room_id': room_id
        }, room=target_sid)
        
        # Also notify everyone in the room
        target_user = User.query.get(target_id)
        if target_user:
            emit('group_chat_message', {
                'type': 'system',
                'username': 'System',
                'message': f'{target_user.username} was removed from the room'
            }, room=room_id)
        
        # Update participant list
        participants = RoomParticipant.query.filter_by(
            room_id=room_id,
            is_active=True
        ).all()
        
        participant_list = []
        for p in participants:
            user = User.query.get(p.user_id)
            participant_list.append({
                'id': user.id,
                'username': user.username,
                'is_host': user.id == room.host_id
            })
        
        emit('group_room_participants', {
            'participants': participant_list
        }, room=room_id)

@socketio.on('start_recording')
def handle_start_recording(data):
    room_id = data.get('room_id')
    
    # Notify everyone in the room that recording has started
    emit('recording_started', {
        'by_user': current_user.username
    }, room=room_id)

@socketio.on('stop_recording')
def handle_stop_recording(data):
    room_id = data.get('room_id')
    
    # Notify everyone in the room that recording has stopped
    emit('recording_stopped', {
        'by_user': current_user.username
    }, room=room_id)

# Create database tables
with app.app_context():
    db.create_all()
    # Create default chatrooms
    create_default_chatrooms()

if __name__ == '__main__':
    # Schedule recording cleanup
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        scheduler = BackgroundScheduler()
        scheduler.add_job(func=cleanup_expired_recordings, trigger="interval", hours=24)
        scheduler.start()
    except ImportError:
        print("APScheduler not installed. Scheduled cleanup disabled.")
    
    socketio.run(app, debug=True, host='0.0.0.0')