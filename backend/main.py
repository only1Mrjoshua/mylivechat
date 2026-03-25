from datetime import datetime
from typing import Dict, List, Optional
import json
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{(DATA_DIR / 'chat.db').as_posix()}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, index=True)
    customer_name = Column(String(255), nullable=False)
    customer_email = Column(String(255), nullable=True)
    status = Column(String(50), default="open")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, nullable=False, index=True)
    sender_type = Column(String(50), nullable=False)  # user | admin | bot
    sender_name = Column(String(255), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


Base.metadata.create_all(bind=engine)

app = FastAPI(title="Live Support Chat API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateConversationRequest(BaseModel):
    customer_name: str
    customer_email: Optional[str] = None
    first_message: str


class SendMessageRequest(BaseModel):
    sender_name: str
    content: str


class CloseConversationRequest(BaseModel):
    status: str = "closed"


class ConnectionManager:
    def __init__(self):
        self.user_connections: Dict[int, List[WebSocket]] = {}
        self.admin_connections: List[WebSocket] = []

    async def connect_user(self, conversation_id: int, websocket: WebSocket):
        await websocket.accept()
        self.user_connections.setdefault(conversation_id, []).append(websocket)

    async def connect_admin(self, websocket: WebSocket):
        await websocket.accept()
        self.admin_connections.append(websocket)

    def disconnect_user(self, conversation_id: int, websocket: WebSocket):
        if conversation_id in self.user_connections:
            self.user_connections[conversation_id] = [
                ws for ws in self.user_connections[conversation_id] if ws != websocket
            ]
            if not self.user_connections[conversation_id]:
                del self.user_connections[conversation_id]

    def disconnect_admin(self, websocket: WebSocket):
        self.admin_connections = [ws for ws in self.admin_connections if ws != websocket]

    async def send_to_conversation(self, conversation_id: int, payload: dict):
        dead = []
        for ws in self.user_connections.get(conversation_id, []):
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                dead.append(ws)

        for ws in dead:
            self.disconnect_user(conversation_id, ws)

    async def send_to_admins(self, payload: dict):
        dead = []
        for ws in self.admin_connections:
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                dead.append(ws)

        for ws in dead:
            self.disconnect_admin(ws)


manager = ConnectionManager()


def message_to_dict(message: Message) -> dict:
    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "sender_type": message.sender_type,
        "sender_name": message.sender_name,
        "content": message.content,
        "created_at": message.created_at.isoformat(),
    }


def conversation_to_dict(conversation: Conversation) -> dict:
    return {
        "id": conversation.id,
        "customer_name": conversation.customer_name,
        "customer_email": conversation.customer_email,
        "status": conversation.status,
        "created_at": conversation.created_at.isoformat(),
        "updated_at": conversation.updated_at.isoformat(),
    }


def create_bot_reply(text: str) -> str:
    lower = text.lower()

    if "withdraw" in lower:
        return (
            "I understand you need help with a withdrawal. "
            "Please share the amount, date, and any error you are seeing."
        )

    if "deposit" in lower or "payment" in lower:
        return (
            "I can help with a deposit or payment issue. "
            "Please send the payment method, amount, and transaction time."
        )

    if "account" in lower or "login" in lower:
        return (
            "For account or login issues, please describe what is happening "
            "and mention any error message you are seeing."
        )

    return (
        "Thanks for your message. A support agent will review this shortly. "
        "Please share any useful details like amount, date, reference number, "
        "or screenshot description."
    )


@app.get("/")
def root():
    return {"message": "Live Support Chat API is running"}


@app.post("/api/conversations")
async def create_conversation(payload: CreateConversationRequest):
    db = SessionLocal()
    try:
        conversation = Conversation(
            customer_name=payload.customer_name,
            customer_email=payload.customer_email,
            status="open",
        )
        db.add(conversation)
        db.commit()
        db.refresh(conversation)

        first_message = Message(
            conversation_id=conversation.id,
            sender_type="user",
            sender_name=payload.customer_name,
            content=payload.first_message,
        )
        db.add(first_message)
        conversation.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(first_message)

        bot_message = Message(
            conversation_id=conversation.id,
            sender_type="bot",
            sender_name="Support Assistant",
            content=create_bot_reply(payload.first_message),
        )
        db.add(bot_message)
        conversation.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(bot_message)
        db.refresh(conversation)

        await manager.send_to_admins(
            {
                "type": "conversation_created",
                "conversation": conversation_to_dict(conversation),
                "latest_message": message_to_dict(bot_message),
            }
        )

        return {
            "conversation": conversation_to_dict(conversation),
            "messages": [
                message_to_dict(first_message),
                message_to_dict(bot_message),
            ],
        }
    finally:
        db.close()


@app.get("/api/conversations")
def list_conversations():
    db = SessionLocal()
    try:
        conversations = (
            db.query(Conversation)
            .order_by(Conversation.updated_at.desc())
            .all()
        )

        data = []
        for conv in conversations:
            latest = (
                db.query(Message)
                .filter(Message.conversation_id == conv.id)
                .order_by(Message.created_at.desc())
                .first()
            )
            item = conversation_to_dict(conv)
            item["latest_message"] = message_to_dict(latest) if latest else None
            data.append(item)

        return data
    finally:
        db.close()


@app.get("/api/conversations/{conversation_id}/messages")
def get_conversation_messages(conversation_id: int):
    db = SessionLocal()
    try:
        conversation = (
            db.query(Conversation)
            .filter(Conversation.id == conversation_id)
            .first()
        )
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        messages = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
            .all()
        )

        return {
            "conversation": conversation_to_dict(conversation),
            "messages": [message_to_dict(m) for m in messages],
        }
    finally:
        db.close()


@app.post("/api/conversations/{conversation_id}/messages/user")
async def send_user_message(conversation_id: int, payload: SendMessageRequest):
    db = SessionLocal()
    try:
        conversation = (
            db.query(Conversation)
            .filter(Conversation.id == conversation_id)
            .first()
        )
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        message = Message(
            conversation_id=conversation_id,
            sender_type="user",
            sender_name=payload.sender_name,
            content=payload.content,
        )
        db.add(message)
        conversation.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(message)

        outgoing = {"type": "new_message", "message": message_to_dict(message)}
        await manager.send_to_conversation(conversation_id, outgoing)
        await manager.send_to_admins(outgoing)

        admin_online = len(manager.admin_connections) > 0

        if not admin_online:
            bot_message = Message(
                conversation_id=conversation_id,
                sender_type="bot",
                sender_name="Support Assistant",
                content=create_bot_reply(payload.content),
            )
            db.add(bot_message)
            conversation.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(bot_message)

            bot_outgoing = {"type": "new_message", "message": message_to_dict(bot_message)}
            await manager.send_to_conversation(conversation_id, bot_outgoing)
            await manager.send_to_admins(bot_outgoing)

        return {"success": True}
    finally:
        db.close()


@app.post("/api/conversations/{conversation_id}/messages/admin")
async def send_admin_message(conversation_id: int, payload: SendMessageRequest):
    db = SessionLocal()
    try:
        conversation = (
            db.query(Conversation)
            .filter(Conversation.id == conversation_id)
            .first()
        )
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        message = Message(
            conversation_id=conversation_id,
            sender_type="admin",
            sender_name=payload.sender_name,
            content=payload.content,
        )
        db.add(message)
        conversation.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(message)

        outgoing = {"type": "new_message", "message": message_to_dict(message)}
        await manager.send_to_conversation(conversation_id, outgoing)
        await manager.send_to_admins(outgoing)

        return {"success": True}
    finally:
        db.close()


@app.patch("/api/conversations/{conversation_id}/close")
def close_conversation(conversation_id: int, payload: CloseConversationRequest):
    db = SessionLocal()
    try:
        conversation = (
            db.query(Conversation)
            .filter(Conversation.id == conversation_id)
            .first()
        )
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")

        conversation.status = payload.status
        conversation.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(conversation)

        return conversation_to_dict(conversation)
    finally:
        db.close()


@app.websocket("/ws/user/{conversation_id}")
async def websocket_user(websocket: WebSocket, conversation_id: int):
    await manager.connect_user(conversation_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_user(conversation_id, websocket)


@app.websocket("/ws/admin")
async def websocket_admin(websocket: WebSocket):
    await manager.connect_admin(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_admin(websocket)