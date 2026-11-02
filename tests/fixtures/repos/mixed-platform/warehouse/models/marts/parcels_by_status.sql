select
    status,
    count(*) as parcel_count
from {{ ref('stg_parcels') }}
group by status
