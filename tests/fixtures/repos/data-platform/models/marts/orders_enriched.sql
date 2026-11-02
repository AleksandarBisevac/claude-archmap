{{ config(materialized='incremental') }}

select
    o.order_id,
    c.name
from {{ ref('stg_orders') }} as o
join {{ ref('stg_customers') }} as c on c.customer_id = o.customer_id
