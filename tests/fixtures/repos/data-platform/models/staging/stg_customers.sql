select
    id as customer_id,
    name
from {{ source('shop', 'customers') }}
