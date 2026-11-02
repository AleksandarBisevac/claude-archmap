select
    name,
    count(*) as orders
from {{ ref('orders_enriched') }}
group by name
