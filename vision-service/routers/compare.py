from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.claude_vision import compare_images

router = APIRouter()


class CompareRequest(BaseModel):
    baseline_image_url: str
    current_image_url: str
    room_name: str | None = None
    property_notes: str | None = None
    userId: str | None = None


class Finding(BaseModel):
    category: str  # missing, moved, cleanliness, damage, inventory
    description: str
    severity: str  # low, medium, high, critical
    confidence: float  # 0-1


class CompareResponse(BaseModel):
    findings: list[Finding]
    summary: str
    readiness_score: float  # 0-100
    raw_response: str | None = None


@router.post("/compare", response_model=CompareResponse)
async def compare_room(request: CompareRequest):
    """Compare a current room photo against its baseline to detect discrepancies."""
    try:
        result = await compare_images(
            baseline_url=request.baseline_image_url,
            current_url=request.current_image_url,
            room_name=request.room_name,
            property_notes=request.property_notes,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
