export default async function VehiclePage({ params }: { params: { vehicleId: string } }) {
  const res = await fetch(`${process.env.API_URL}/vehicles/${params.vehicleId}`);
  const vehicle = await res.json();
  return <main>{vehicle.plate}</main>;
}
