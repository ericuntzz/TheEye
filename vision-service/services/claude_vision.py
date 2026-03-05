import os
import json
import httpx
import base64
import anthropic

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

COMPARISON_PROMPT = """You are a luxury property inspection assistant with an obsessive eye for detail.

You will receive two images:
- FIRST IMAGE: The BASELINE showing how this room should look in its perfect state.
- SECOND IMAGE: The CURRENT state showing how it looks right now.

Compare them and identify every discrepancy across these categories:
1. MISSING ITEMS: Objects present in baseline but absent in current
2. MOVED/MISPLACED: Objects in wrong position or arrangement
3. CLEANLINESS: Stains, smudges, debris, disorder not in baseline
4. DAMAGE/RISK: New damage, potential hazards, water issues
5. INVENTORY: Consumables that appear low or depleted

{context}

Return a JSON response with this exact structure:
{{
  "findings": [
    {{
      "category": "missing|moved|cleanliness|damage|inventory",
      "description": "Specific description of the issue",
      "severity": "low|medium|high|critical",
      "confidence": 0.0-1.0
    }}
  ],
  "summary": "Brief overall assessment in 1-2 sentences",
  "readiness_score": 0-100
}}

If the room looks perfect and matches the baseline, return an empty findings array and a readiness_score of 100.
Only return valid JSON, no other text."""


async def fetch_image_as_base64(url: str) -> tuple[str, str]:
    """Fetch an image from URL and return as base64 with media type."""
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
        response.raise_for_status()

    content_type = response.headers.get("content-type", "image/jpeg")
    media_type = content_type.split(";")[0].strip()
    b64 = base64.standard_b64encode(response.content).decode("utf-8")
    return b64, media_type


async def compare_images(
    baseline_url: str,
    current_url: str,
    room_name: str | None = None,
    property_notes: str | None = None,
) -> dict:
    """Compare baseline and current images using Claude Vision API."""
    if not ANTHROPIC_API_KEY:
        raise ValueError("ANTHROPIC_API_KEY environment variable is not set")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Build context string
    context_parts = []
    if room_name:
        context_parts.append(f"Room: {room_name}")
    if property_notes:
        context_parts.append(f"Additional context: {property_notes}")
    context = "\n".join(context_parts) if context_parts else ""

    # Fetch images
    baseline_b64, baseline_type = await fetch_image_as_base64(baseline_url)
    current_b64, current_type = await fetch_image_as_base64(current_url)

    # Call Claude Vision API
    message = client.messages.create(
        model="claude-sonnet-4-5-20250514",
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "BASELINE IMAGE (how the room should look):",
                    },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": baseline_type,
                            "data": baseline_b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": "CURRENT IMAGE (how the room looks now):",
                    },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": current_type,
                            "data": current_b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": COMPARISON_PROMPT.format(context=context),
                    },
                ],
            }
        ],
    )

    raw_response = message.content[0].text

    # Parse the JSON response
    try:
        result = json.loads(raw_response)
    except json.JSONDecodeError:
        # Try to extract JSON from the response
        start = raw_response.find("{")
        end = raw_response.rfind("}") + 1
        if start != -1 and end > start:
            result = json.loads(raw_response[start:end])
        else:
            raise ValueError(f"Could not parse vision API response: {raw_response}")

    result["raw_response"] = raw_response
    return result
