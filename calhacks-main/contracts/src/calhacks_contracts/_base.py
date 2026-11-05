from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

Address = Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]{40}$")]
BaseUnits = Annotated[str, Field(pattern=r"^[0-9]+$", description="USDC base units (6 decimals)")]
IsoDate = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}")]
Label = Literal["scam", "legit"]
AttackerKnowledge = Literal["blind", "white_box"]


class Strict(BaseModel):
    """Unknown fields are rejected, so nothing extra can ride along into the Gate."""
    model_config = ConfigDict(extra="forbid")
