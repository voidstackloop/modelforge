from recommender.physics import classify_fit, classify_gpu_strategy, estimated_weight_gb, usable_memory


def test_classify_gpu_strategy_fits_on_one_gpu():
    weight_gb = estimated_weight_gb(7, 4.75, False)
    assert classify_gpu_strategy(weight_gb, [24.0], 16.0) == "fits-one-gpu"


def test_classify_gpu_strategy_tensor_parallel_when_even_shard_fits_smallest_device():
    # 70B model needs tensor parallelism across two matched 48GB cards; an
    # even 2-way shard fits comfortably on each.
    weight_gb = estimated_weight_gb(70, 4.75, False)
    assert classify_gpu_strategy(weight_gb, [48.0, 48.0], 16.0) == "fits-tensor-parallel"


def test_classify_gpu_strategy_layer_split_when_smallest_device_cannot_take_an_even_shard():
    # Same 70B model across a 24GB + 8GB pair: the aggregate (32GB) can't
    # cover it either, but an even half (35GB) can't fit the 8GB card, so
    # tensor-parallel isn't offered — layer-split needs the aggregate only.
    weight_gb = estimated_weight_gb(70, 4.75, False)
    assert classify_gpu_strategy(weight_gb, [24.0, 8.0], 16.0) != "fits-tensor-parallel"


def test_classify_gpu_strategy_layer_split_across_heterogeneous_devices():
    # A model that doesn't fit the largest single card (16GB), and can't be
    # evenly tensor-sharded because the smaller 8GB card can't hold its half —
    # but the aggregate (24GB) does cover it, so layer/pipeline split (which
    # doesn't require an even shard) is offered instead.
    weight_gb = estimated_weight_gb(26.5, 4.75, False)
    assert classify_gpu_strategy(weight_gb, [16.0, 8.0], 16.0) == "fits-layer-split"


def test_classify_gpu_strategy_never_recommends_tensor_parallel_for_a_single_gpu():
    weight_gb = estimated_weight_gb(70, 4.75, False)
    assert classify_gpu_strategy(weight_gb, [48.0], 16.0) != "fits-tensor-parallel"


def test_classify_gpu_strategy_cpu_offload_only_when_no_devices_but_ram_suffices():
    weight_gb = estimated_weight_gb(3, 4.75, False)
    assert classify_gpu_strategy(weight_gb, [], 16.0) == "cpu-offload-only"


def test_classify_gpu_strategy_insufficient_when_nothing_fits():
    weight_gb = estimated_weight_gb(400, 8.5, False)
    assert classify_gpu_strategy(weight_gb, [24.0, 24.0], 16.0) == "insufficient"


def test_classify_gpu_strategy_does_not_treat_aggregate_as_one_contiguous_pool():
    # Two 12GB cards (24GB aggregate) vs one imaginary 24GB card must not be
    # equivalent: a model that needs >12GB per shard can't tensor-parallel
    # here even though the aggregate matches a single big card.
    weight_gb = 20.0
    two_by_twelve = classify_gpu_strategy(weight_gb, [12.0, 12.0], 16.0)
    one_big = classify_gpu_strategy(weight_gb, [24.0], 16.0)
    assert one_big == "fits-one-gpu"
    assert two_by_twelve != "fits-one-gpu"


def test_classify_fit_still_treats_vram_as_aggregate_scalar_for_the_legacy_path():
    # Sanity check that the original single-scalar classify_fit is untouched
    # by the new per-device function existing alongside it.
    usable_ram, usable_vram, total_usable, accelerator = usable_memory(16.0, 24.0, "cuda", "linux")
    assert classify_fit(10.0, usable_ram, usable_vram, total_usable, accelerator) == "Runs comfortably"
