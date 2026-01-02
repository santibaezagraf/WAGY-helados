import { createClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { PedidosClient } from '@/components/pedidos/pedidos-client'


export default async function Home() {
    const supabase = await createClient();

    const  {data: { user } } = await supabase.auth.getUser();

    if (!user) {
        redirect('/login')
    }

    const { data: pedidos, error } = await supabase
        .from('pedidos')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return ( 
            <div>Error al cargar los pedidos: {error.message}</div>
        );
    }

    return (
        <div className="flex min-h-screen flex-col items-center p-24">
            <h1 className="text-4xl font-bold mb-8">Bienvenido {user.email}</h1>

            <div className="w-full max-w-7xl">
                <PedidosClient initialData={pedidos || []} />
            </div>
        </div>
    )
}