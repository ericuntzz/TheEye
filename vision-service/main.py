import os
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import compare

load_dotenv()

app = FastAPI(
    title="The Eye - Vision Service",
    description="AI-powered visual intelligence for luxury property inspections",
    version="0.1.0",
)

origins = ["http://localhost:5000"]
replit_domain = os.getenv("REPLIT_DEV_DOMAIN")
if replit_domain:
    origins.append(f"https://{replit_domain}")
replit_domains = os.getenv("REPLIT_DOMAINS")
if replit_domains:
    for domain in replit_domains.split(","):
        origins.append(f"https://{domain.strip()}")
custom_origins = os.getenv("ALLOWED_ORIGINS")
if custom_origins:
    origins.extend(custom_origins.split(","))

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(compare.router, prefix="/api/v1")


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "the-eye-vision",
    }
