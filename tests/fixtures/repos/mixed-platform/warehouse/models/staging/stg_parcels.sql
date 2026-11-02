select
    id as parcel_id,
    status,
    shipped_at
from {{ source('parcels_db', 'parcels') }}
